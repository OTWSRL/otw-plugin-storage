import type { Credentials } from './sigv4'

/** The S3-compatible services with a preset, and `custom` for any other, a server of one's own included. */
export type S3Service = 'aws' | 'r2' | 'supabase' | 'custom'

/**
 * How a file's key is kept from being written twice. `header`: the service refuses the second
 * write itself (`If-None-Match: *`). `check`: it's looked for first, under a lock, for services
 * that don't.
 */
export type NoOverwrite = 'header' | 'check'

/** What Settings › Storage and the environment say about an S3-compatible bucket, as typed. */
export interface S3Settings {
  service: S3Service
  bucket: string
  region: string
  /** Cloudflare's account ID, or Supabase's project reference. */
  account: string
  /** A custom service's address, such as `https://s3.example.com`. */
  endpoint: string
  pathStyle: boolean
  noOverwrite: NoOverwrite
  /** Where the bucket's files are public, such as a CDN's address; empty to serve through the site. */
  publicUrl: string
  /** A folder inside the bucket, for a bucket shared with something else. */
  prefix: string
  accessKeyId: string | undefined
  secretAccessKey: string | undefined
  /** `Cache-Control` for stored files. */
  cacheControl: string
}

/** A bucket ready to be talked to: every address worked out, every input checked. */
export interface S3Config {
  /** The address objects live under, without a trailing slash: the bucket's own. */
  base: string
  region: string
  credentials: Credentials
  noOverwrite: NoOverwrite
  prefix: string
  cacheControl: string
  /** Where files are public, without a trailing slash, or `null`. */
  publicUrl: string | null
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/
const ACCOUNT = /^[a-z0-9]{6,64}$/i
const PREFIX_SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/i

/** `folder/sub/` from what was typed, or `null` when it couldn't be a folder's path. */
export function cleanPrefix(value: string): string | null {
  const segments = value.trim().split('/').filter(Boolean)
  if (segments.some((segment) => !PREFIX_SEGMENT.test(segment) || segment.includes('..'))) {
    return null
  }
  return segments.length > 0 ? `${segments.join('/')}/` : ''
}

/** An address on the web without a query, sign-in or fragment, and no trailing slash; or `null`. */
export function cleanUrl(value: string, options: { http: boolean }): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const allowed = url.protocol === 'https:' || (options.http && url.protocol === 'http:')
  if (!allowed || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function endpointOf(settings: S3Settings): { endpoint: string; pathStyle: boolean } | string {
  switch (settings.service) {
    case 'aws':
      if (!REGION.test(settings.region)) return 'Enter the bucket’s region, such as eu-west-1.'
      // A dot in a bucket's name breaks the certificate of its own host name.
      return {
        endpoint: `https://s3.${settings.region}.amazonaws.com`,
        pathStyle: settings.bucket.includes('.'),
      }
    case 'r2':
      if (!ACCOUNT.test(settings.account)) return 'Enter the Cloudflare account ID.'
      return {
        endpoint: `https://${settings.account.toLowerCase()}.r2.cloudflarestorage.com`,
        pathStyle: true,
      }
    case 'supabase':
      if (!ACCOUNT.test(settings.account)) return 'Enter the Supabase project’s reference.'
      if (!REGION.test(settings.region)) return 'Enter the project’s region, such as eu-central-1.'
      return {
        endpoint: `https://${settings.account.toLowerCase()}.storage.supabase.co/storage/v1/s3`,
        pathStyle: true,
      }
    case 'custom': {
      // A server of one's own may be on a private network without a certificate.
      const endpoint = cleanUrl(settings.endpoint, { http: true })
      if (!endpoint) return 'Enter the service’s address, such as https://s3.example.com.'
      if (!REGION.test(settings.region)) return 'Enter a region; many servers take us-east-1.'
      return { endpoint, pathStyle: settings.pathStyle }
    }
  }
}

/** Services whose second write to a key is known to be refused by the header alone. */
const HEADER_SERVICES: ReadonlySet<S3Service> = new Set(['aws', 'r2'])

/** The bucket's configuration, or what's missing or wrong, in a sentence. */
export function s3Config(settings: S3Settings): S3Config | string {
  if (!BUCKET.test(settings.bucket)) return 'Enter the bucket’s name.'
  const where = endpointOf(settings)
  if (typeof where === 'string') return where
  if (!settings.accessKeyId || !settings.secretAccessKey) {
    return 'Set STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY in the site’s environment.'
  }
  const prefix = cleanPrefix(settings.prefix)
  if (prefix === null) return 'The folder may hold letters, digits, dots, dashes and slashes.'
  const publicUrl = settings.publicUrl.trim() ? cleanUrl(settings.publicUrl, { http: true }) : null
  if (settings.publicUrl.trim() && !publicUrl) {
    return 'The public address must be a web address, such as https://media.example.com.'
  }
  const endpoint = new URL(where.endpoint)
  const base = where.pathStyle
    ? `${where.endpoint}/${settings.bucket}`
    : `${endpoint.protocol}//${settings.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, '')}`
  return {
    base,
    region: settings.service === 'r2' ? 'auto' : settings.region,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    noOverwrite:
      settings.service === 'custom'
        ? settings.noOverwrite
        : HEADER_SERVICES.has(settings.service)
          ? 'header'
          : 'check',
    prefix,
    cacheControl: settings.cacheControl,
    publicUrl,
  }
}

/** What a browser may show in the page; anything else downloads. The CMS's own rule. */
const INLINE = /^(image|audio|video|text)\/|^application\/pdf$/

/** `Content-Disposition` for a stored file, from its type. */
export function dispositionFor(contentType: string): 'inline' | 'attachment' {
  return INLINE.test(contentType) ? 'inline' : 'attachment'
}

/** The choices for how long browsers and CDNs may keep a file, as `Cache-Control`. */
export const CACHE_CONTROL = {
  day: 'public, max-age=86400',
  month: 'public, max-age=2592000',
  year: 'public, max-age=31536000',
} as const

export type CacheChoice = keyof typeof CACHE_CONTROL

export function cacheControlFor(choice: string | undefined): string {
  return CACHE_CONTROL[(choice ?? 'day') as CacheChoice] ?? CACHE_CONTROL.day
}
