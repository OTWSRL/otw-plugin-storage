import type { MediaStorage, RegistryItem, StoredFile, UploadTarget } from '@otwdesign/sdk'

/** A storage service, opened: what the media library asks of it. */
export interface StorageConnection {
  /** Writes a new file. Returns `false`, writing nothing, when the key is taken. */
  create(key: string, data: Uint8Array, contentType: string): Promise<boolean>
  /** The file's bytes, or those from `start` to `end` (inclusive); `null` when there's none. */
  read(key: string, range?: { start: number; end: number }): Promise<StoredFile | null>
  stat(key: string): Promise<{ size: number; modifiedAt: Date } | null>
  /** Removes the file; a missing one is not an error. */
  delete(key: string): Promise<void>
  /** Signs an address a browser can send one file to. Left out by services that can't. */
  uploadTarget?(key: string, options: { size: number; expiresAt: Date }): Promise<UploadTarget>
}

/**
 * A way to keep the media library's files: S3 and Vercel Blob are built in, and a plugin adds
 * another to the `storage.drivers` registry. Everything but `connect()` answers at once, from
 * settings and the environment alone: it's asked while pages render.
 */
export interface StorageDriver extends RegistryItem {
  /** Shown on Storage's screens. */
  label: string
  /** What's missing before it can be used, in a sentence; `null` when it's ready. No I/O. */
  problem(): string | null
  /** A file's public address, or `null` to serve it through the site's `/uploads/` route. */
  publicUrl(key: string): string | null
  /** Whether a browser can send files straight to it. */
  directUploads: boolean
  /** What an administrator should know about how it's set up, for the Status screen. No I/O. */
  warnings?(): string[]
  /** Opens it, on first use: where a driver loads what it needs. */
  connect(): Promise<StorageConnection>
}

declare module '@otwdesign/sdk' {
  interface Registries {
    /** Storage drivers added by plugins, beside the built-in S3 and Vercel Blob. */
    'storage.drivers': StorageDriver
  }
}

/** The driver Settings › Storage chose, or why there's none to use. */
export function chooseDriver(
  choice: string,
  builtIn: Readonly<Record<string, StorageDriver>>,
  added: readonly StorageDriver[],
): StorageDriver | string {
  if (choice === 'plugin') {
    return added[0] ?? 'No plugin has added a storage driver. Choose another, or install one.'
  }
  return builtIn[choice] ?? 'Choose where files are kept.'
}

/** The path the CMS serves uploads at, from whichever storage is in use. */
const UPLOADS_PATH = '/uploads'

/**
 * The driver as the CMS's media storage. It's opened on the first file, not when the site
 * starts, and opened again after a failure. A driver that isn't ready fails each file with what
 * it's missing: falling back to the disk would scatter a site's files over two places.
 */
export function toMediaStorage(
  resolve: () => StorageDriver | string,
  options: { minBytes: () => number | null },
): MediaStorage {
  let opened: { driver: StorageDriver; connection: Promise<StorageConnection> } | null = null
  const connection = (): Promise<StorageConnection> => {
    const driver = resolve()
    const problem = typeof driver === 'string' ? driver : driver.problem()
    if (typeof driver === 'string' || problem) {
      return Promise.reject(new Error(`The media storage isn’t ready: ${problem}`))
    }
    if (opened?.driver !== driver) {
      const connecting = driver.connect()
      opened = { driver, connection: connecting }
      connecting.catch(() => {
        if (opened?.connection === connecting) opened = null
      })
    }
    return opened.connection
  }
  const ready = (): StorageDriver | null => {
    const driver = resolve()
    return typeof driver === 'string' || driver.problem() ? null : driver
  }

  return {
    create: async (key, data, contentType) => (await connection()).create(key, data, contentType),
    read: async (key, range) => (await connection()).read(key, range),
    stat: async (key) => (await connection()).stat(key),
    delete: async (key) => (await connection()).delete(key),
    url(key) {
      const driver = resolve()
      const address = typeof driver === 'string' ? null : driver.publicUrl(key)
      return address ?? `${UPLOADS_PATH}/${key}`
    },
    get directUploads() {
      const minBytes = options.minBytes()
      if (minBytes === null || !ready()?.directUploads) return undefined
      return {
        minBytes,
        async target(key: string, target: { size: number; expiresAt: Date }) {
          const sign = (await connection()).uploadTarget
          if (!sign) throw new Error('The media storage takes no uploads from browsers')
          return sign(key, target)
        },
      }
    },
  }
}
