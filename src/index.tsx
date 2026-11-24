import { definePlugin, type AdminIcon, type SettingCondition } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { checkConnection, type CheckResult } from './check'
import {
  cacheControlFor,
  s3Config,
  type NoOverwrite,
  type S3Service,
  type S3Settings,
} from './config'
import { createCopyService, type CopyService } from './copy'
import { chooseDriver, toMediaStorage, type StorageConnection, type StorageDriver } from './drivers'
import { migrations, TABLES } from './migrations'
import { s3Connection } from './s3'
import { createUsageCounter, mediaUsage, parseLimit, type CountedUsage } from './usage'
import { blobDriver } from './vercel-blob'

export type { CheckResult } from './check'
export type { StorageConnection, StorageDriver } from './drivers'
export { StorageError } from './http'
export type { MediaUsage } from './usage'

/** Files this large, in bytes, go from the browser straight to storage: under Vercel's 4.5 MB. */
export const DIRECT_FROM_BYTES = 4 * 1024 * 1024

const CACHE_SECONDS: Readonly<Record<string, number>> = {
  day: 86_400,
  month: 2_592_000,
  year: 31_536_000,
}

// A bucket, in the admin menu's style: one colour, which the menu sets.
const BUCKET =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M10 2C6.1 2 3 3.1 3 4.6c0 .1 0 .2.1.3L4.6 16c.2 1.2 2.5 2 5.4 2s5.2-.8 5.4-2l1.5-11.1c.1-.1.1-.2.1-.3C17 3.1 13.9 2 10 2zm0 1.5c3.2 0 5.3.8 5.5 1.1-.2.3-2.3 1.1-5.5 1.1s-5.3-.8-5.5-1.1c.2-.3 2.3-1.1 5.5-1.1z"/></svg>'
const ICON: AdminIcon = `data:image/svg+xml;base64,${Buffer.from(BUCKET).toString('base64')}`

declare module '@otwdesign/sdk' {
  interface Settings {
    /** On, the media library's files are kept in the storage chosen, not on the disk. */
    'storage.active': boolean
    /** `s3`, `vercel-blob`, or `plugin` for a driver another plugin added. */
    'storage.driver': string
    /** Which uploads browsers send straight to storage: `large`, `always` or `off`. */
    'storage.direct_uploads': string
    /** How long browsers may keep a file: `day`, `month` or `year`. */
    'storage.cache': string
    /** A folder inside the bucket or store. */
    'storage.prefix': string
    /** The plan's limit, in GB, to compare the space used with; empty for none. */
    'storage.limit_gb': string
    /** `aws`, `r2`, `supabase` or `custom`. */
    'storage.s3_service': string
    /** The bucket's name. */
    'storage.s3_bucket': string
    /** The bucket's region, such as `eu-west-1`; Cloudflare R2 needs none. */
    'storage.s3_region': string
    /** Cloudflare's account ID, or Supabase's project reference. */
    'storage.s3_account': string
    /** A custom service's address, such as `https://s3.example.com`, without the bucket. */
    'storage.s3_endpoint': string
    /** Whether a custom service has the bucket in the path, not in the host name. */
    'storage.s3_path_style': boolean
    /** `check` or `header`: how a custom service is kept from writing over a file. */
    'storage.s3_no_overwrite': string
    /** The bucket's access key ID, from `STORAGE_S3_ACCESS_KEY_ID` only. */
    'storage.s3_access_key_id': string
    /** The bucket's secret access key, from `STORAGE_S3_SECRET_ACCESS_KEY` only. */
    'storage.s3_secret_access_key': string
    /** Where the bucket's files are public; empty serves them through the site. */
    'storage.public_url': string
    /** `public` or `private`: how the Vercel Blob store was made. */
    'storage.blob_access': string
    /** The Vercel Blob store's read-write token, from `BLOB_READ_WRITE_TOKEN` only. */
    'storage.blob_token': string
  }
  interface Capabilities {
    /** May change the storage's settings, test its connection and copy files to it. */
    'storage.manage': true
  }
  interface Jobs {
    /** Goes on with a run of "Copy Files to Storage", a batch at a time. */
    'storage.copy': { run: string }
  }
  interface Services {
    /** The Storage plugin: its driver's state, for another plugin's screens. */
    storage: StorageService
  }
}

/** `cms.services.get('storage')`: what the plugin tells others. */
export interface StorageService {
  /** Whether the media library's files are kept in the storage, and by which driver. */
  status(): { active: boolean; driver: string | null; problem: string | null }
  /**
   * How much the media library holds, from its own records, and the limit set in Settings ›
   * Storage, in bytes (`null` for none). It asks the database once and the storage nothing.
   */
  usage(): Promise<StorageUsage>
}

/**
 * The space the media library uses, against the limit typed in the settings. `countedAt` is now
 * for most libraries; a very large one is counted at most every five minutes.
 */
export interface StorageUsage extends CountedUsage {
  /** The limit in bytes, or `null` when none is set or what's typed isn't a number. */
  limitBytes: number | null
}

/** What the admin entry uses of the site entry's setup: one kernel's, found by its service. */
interface Internals {
  driver(): StorageDriver | string
  active(): boolean
  directFrom(): number | null
  copy: CopyService
  /** Tries the storage out. Without the site's address, uploads from a browser go unchecked. */
  check(siteOrigin: string | null): Promise<CheckResult[]>
}

const internals = new WeakMap<StorageService, Internals>()

/** The setup's own parts, for the admin entry. */
export function internalsOf(service: StorageService): Internals {
  const made = internals.get(service)
  if (!made) throw new Error('The Storage plugin’s service isn’t its own')
  return made
}

const S3: SettingCondition = { setting: 'storage.driver', is: 's3' }
const BLOB: SettingCondition = { setting: 'storage.driver', is: 'vercel-blob' }
const service = (...services: S3Service[]) =>
  services.map((is): SettingCondition[] => [S3, { setting: 'storage.s3_service', is }])

export default definePlugin({
  id: 'storage',
  version: '1.1.0',
  name: 'Storage',
  description:
    'Keeps the media library’s files in object storage: S3, Cloudflare R2, Supabase Storage, a server of your own, or Vercel Blob.',
  icon: ICON,
  requires: { core: '^1.9.0' },
  migrations,
  settings: {
    'storage.active': {
      type: 'boolean',
      label: 'Keep uploads in this storage',
      description:
        'Off, uploads stay on the server’s disk while you set the storage up and test it. Once on, don’t switch back: files uploaded since would be left behind.',
      default: false,
      env: 'STORAGE_ACTIVE',
    },
    'storage.driver': {
      type: 'select',
      label: 'Where',
      default: 's3',
      env: 'STORAGE_DRIVER',
      options: [
        { value: 's3', label: 'S3 or a service that speaks it' },
        { value: 'vercel-blob', label: 'Vercel Blob' },
        { value: 'plugin', label: 'A driver another plugin adds' },
      ],
    },
    'storage.direct_uploads': {
      type: 'select',
      label: 'Uploads from the browser',
      description:
        'A host such as Vercel refuses a request over 4.5 MB, so larger files must go from the browser straight to the storage, which has to allow it (CORS).',
      default: 'large',
      options: [
        { value: 'large', label: 'Files of 4 MB or more go straight to storage' },
        { value: 'always', label: 'Every file goes straight to storage' },
        { value: 'off', label: 'Every file goes through the site' },
      ],
    },
    'storage.cache': {
      type: 'select',
      label: 'Browsers keep a file for',
      description:
        'A deleted file’s name can be used again by a later upload, which then shows only once this has passed.',
      default: 'day',
      options: [
        { value: 'day', label: 'A day' },
        { value: 'month', label: '30 days' },
        { value: 'year', label: 'A year' },
      ],
    },
    'storage.prefix': {
      type: 'text',
      label: 'Folder',
      description: 'Inside the bucket, for one shared with something else. Empty for its top.',
      default: '',
      maxLength: 200,
      env: 'STORAGE_PREFIX',
    },
    'storage.limit_gb': {
      type: 'text',
      label: 'Storage limit, in GB',
      description:
        'Your plan’s limit, such as 5 or 0.5. The Status screen shows the space used against it. It doesn’t stop uploads; empty shows the space used alone.',
      default: '',
      maxLength: 12,
    },
    'storage.s3_service': {
      type: 'select',
      label: 'Service',
      default: 'aws',
      options: [
        { value: 'aws', label: 'Amazon S3' },
        { value: 'r2', label: 'Cloudflare R2' },
        { value: 'supabase', label: 'Supabase Storage' },
        { value: 'custom', label: 'Another, or a server of your own' },
      ],
      showWhen: S3,
    },
    'storage.s3_bucket': {
      type: 'text',
      label: 'Bucket',
      default: '',
      maxLength: 63,
      env: 'STORAGE_S3_BUCKET',
      showWhen: S3,
    },
    'storage.s3_account': {
      type: 'text',
      label: 'Account or project',
      description: 'Cloudflare’s account ID, or the Supabase project’s reference.',
      default: '',
      maxLength: 64,
      env: 'STORAGE_S3_ACCOUNT',
      showWhen: { any: service('r2', 'supabase') },
    },
    'storage.s3_region': {
      type: 'text',
      label: 'Region',
      description: 'Such as eu-west-1. A server of your own usually takes us-east-1.',
      default: '',
      maxLength: 63,
      env: 'STORAGE_S3_REGION',
      showWhen: { any: service('aws', 'supabase', 'custom') },
    },
    'storage.s3_endpoint': {
      type: 'text',
      label: 'Address',
      description: 'The service’s own, such as https://s3.example.com, without the bucket.',
      default: '',
      maxLength: 300,
      env: 'STORAGE_S3_ENDPOINT',
      showWhen: { any: service('custom') },
    },
    'storage.s3_path_style': {
      type: 'boolean',
      label: 'The bucket is part of the path',
      description:
        'https://s3.example.com/bucket, as MinIO, Garage and most servers have it. Off for https://bucket.s3.example.com.',
      default: true,
      showWhen: { any: service('custom') },
    },
    'storage.s3_no_overwrite': {
      type: 'select',
      label: 'Never write over a file',
      description:
        'Two uploads of one name must not replace each other. Looking first is safe everywhere; leave it to the service only if the connection test says it refuses.',
      default: 'check',
      options: [
        { value: 'check', label: 'Look first, under a lock' },
        { value: 'header', label: 'The service refuses (If-None-Match)' },
      ],
      showWhen: { any: service('custom') },
    },
    'storage.s3_access_key_id': {
      type: 'secret',
      label: 'Access key ID',
      env: 'STORAGE_S3_ACCESS_KEY_ID',
      showWhen: S3,
    },
    'storage.s3_secret_access_key': {
      type: 'secret',
      label: 'Secret access key',
      env: 'STORAGE_S3_SECRET_ACCESS_KEY',
      showWhen: S3,
    },
    'storage.public_url': {
      type: 'text',
      label: 'Public address',
      description:
        'Where the bucket’s files are open to all, such as a CDN’s or a custom domain’s: https://media.example.com. Empty keeps the bucket private and serves files through the site.',
      default: '',
      maxLength: 300,
      env: 'STORAGE_PUBLIC_URL',
      showWhen: S3,
    },
    'storage.blob_access': {
      type: 'select',
      label: 'The store is',
      description: 'As it was made on Vercel. A private store’s files are served through the site.',
      default: 'public',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'private', label: 'Private' },
      ],
      showWhen: BLOB,
    },
    'storage.blob_token': {
      type: 'secret',
      label: 'Read-write token',
      description: 'Vercel sets it when a Blob store is connected to the project.',
      env: 'BLOB_READ_WRITE_TOKEN',
      showWhen: BLOB,
    },
  },

  uninstall: async ({ db }) => {
    for (const table of TABLES) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`))
  },

  setup(cms) {
    const env = process.env
    const setting = cms.settings.get
    cms.auth.capability('storage.manage', { label: 'Manage storage and its settings' })
    const added = cms.registries.define('storage.drivers')

    const s3Settings = (): S3Settings => ({
      service: (setting('storage.s3_service') ?? 'aws') as S3Service,
      bucket: (setting('storage.s3_bucket') ?? '').trim(),
      region: (setting('storage.s3_region') ?? '').trim(),
      account: (setting('storage.s3_account') ?? '').trim(),
      endpoint: setting('storage.s3_endpoint') ?? '',
      pathStyle: setting('storage.s3_path_style') ?? true,
      noOverwrite: (setting('storage.s3_no_overwrite') ?? 'check') as NoOverwrite,
      publicUrl: setting('storage.public_url') ?? '',
      prefix: setting('storage.prefix') ?? '',
      accessKeyId: setting('storage.s3_access_key_id')?.trim() || undefined,
      secretAccessKey: setting('storage.s3_secret_access_key')?.trim() || undefined,
      cacheControl: cacheControlFor(setting('storage.cache')),
    })

    /** One upload of a name at a time, on every server: a lock the database holds. */
    const lock = <T,>(key: string, fn: () => Promise<T>) =>
      cms.transaction(async () => {
        await cms.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
        return fn()
      })

    const s3: StorageDriver = {
      id: 's3',
      label: 'S3',
      directUploads: true,
      problem() {
        const config = s3Config(s3Settings())
        return typeof config === 'string' ? config : null
      },
      publicUrl(key) {
        const config = s3Config(s3Settings())
        return typeof config === 'string' || !config.publicUrl
          ? null
          : `${config.publicUrl}/${config.prefix}${key}`
      },
      async connect(): Promise<StorageConnection> {
        const config = s3Config(s3Settings())
        if (typeof config === 'string') throw new Error(config)
        return s3Connection(config, { fetch, lock })
      },
    }
    const blob = blobDriver(() => ({
      access: setting('storage.blob_access') === 'private' ? 'private' : 'public',
      token: setting('storage.blob_token')?.trim() || undefined,
      storeId: env.BLOB_STORE_ID?.trim() || undefined,
      oidc: Boolean(env.VERCEL_OIDC_TOKEN),
      prefix: setting('storage.prefix') ?? '',
      cacheSeconds: CACHE_SECONDS[setting('storage.cache') ?? 'day'] ?? CACHE_SECONDS.day!,
    }))
    const builtIn = { [s3.id]: s3, [blob.id]: blob }

    const driver = () => chooseDriver(setting('storage.driver') ?? 's3', builtIn, added.list())
    const active = () => setting('storage.active') === true
    const directFrom = (): number | null => {
      const choice = setting('storage.direct_uploads') ?? 'large'
      return choice === 'off' ? null : choice === 'always' ? 0 : DIRECT_FROM_BYTES
    }

    // Off, nothing is provided: uploads stay on the disk, on the paths they always took.
    if (active()) cms.media.storage(toMediaStorage(driver, { minBytes: directFrom }))

    const connect = async () => {
      const chosen = driver()
      const problem = typeof chosen === 'string' ? chosen : chosen.problem()
      if (typeof chosen === 'string' || problem) throw new Error(problem ?? '')
      return chosen.connect()
    }
    const copy = createCopyService({
      db: () => cms.db,
      logger: cms.logger,
      media: cms.media,
      connect,
      enqueue: (run) => cms.jobs.enqueue('storage.copy', { run }),
    })
    cms.jobs.define('storage.copy', {
      label: 'Copy the disk’s uploads to storage',
      handler: ({ run }) => copy.work(run),
    })

    const countUsage = createUsageCounter(() => mediaUsage(cms.db))
    const storage: StorageService = {
      async usage() {
        const limit = parseLimit(setting('storage.limit_gb'))
        return { ...(await countUsage()), limitBytes: limit === 'invalid' ? null : limit }
      },
      status() {
        const chosen = driver()
        return {
          active: active(),
          driver: typeof chosen === 'string' ? null : chosen.id,
          problem: typeof chosen === 'string' ? chosen : chosen.problem(),
        }
      },
    }
    internals.set(storage, {
      driver,
      active,
      directFrom,
      copy,
      async check(siteOrigin) {
        const chosen = driver()
        const problem = typeof chosen === 'string' ? chosen : chosen.problem()
        if (typeof chosen === 'string' || problem) {
          return [{ step: 'Finish the settings', ok: false, detail: problem ?? '' }]
        }
        return checkConnection(chosen, { siteOrigin, fetch })
      },
    })
    cms.services.provide('storage', storage)
  },
})
