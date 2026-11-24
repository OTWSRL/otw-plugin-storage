import type { StoredFile } from '@otwdesign/sdk'
// Types only: the SDK itself is loaded when a store is first used.
import type * as VercelBlob from '@vercel/blob'
import { cleanPrefix, isSafeKey } from './config'
import type { StorageConnection, StorageDriver } from './drivers'
import { request, StorageError, type Fetch } from './http'

/** What the driver uses of `@vercel/blob`, so a test can stand in for it. */
export type BlobSdk = Pick<
  typeof VercelBlob,
  'put' | 'head' | 'get' | 'del' | 'issueSignedToken' | 'presignUrl'
>

/** What Settings › Storage and the environment say about a Vercel Blob store. */
export interface BlobSettings {
  /** How the store was made: its files open to all, or only to the site. */
  access: 'public' | 'private'
  /** `BLOB_READ_WRITE_TOKEN`. Left out on Vercel with OIDC, where the SDK signs in itself. */
  token: string | undefined
  /** `BLOB_STORE_ID`, or the one in the token. */
  storeId: string | undefined
  /** Whether Vercel's OIDC token is there to sign in with instead of a token. */
  oidc: boolean
  prefix: string
  /** How long browsers and the CDN may keep a file, in seconds. */
  cacheSeconds: number
}

/** What a browser's upload is kept as until the site has read it. */
const WAITING_TYPE = 'application/octet-stream'
/** A waiting file the site never read goes by itself after a day. */
const WAITING_DAYS = 1

/**
 * The store's id: the one in the read-write token when there is a token, since that's the store
 * the SDK writes to; `BLOB_STORE_ID` only when signing in without one.
 */
export function blobStoreId(settings: Pick<BlobSettings, 'storeId' | 'token'>): string | null {
  const inToken = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(settings.token ?? '')?.[1]
  const found = settings.token ? inToken : settings.storeId?.trim().replace(/^store_/, '')
  return found && /^[A-Za-z0-9]+$/.test(found) ? found : null
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'BlobNotFoundError'
}

/** The SDK's errors in the plugin's own, without whatever their messages quote. */
function asStorageError(what: string, error: unknown): StorageError {
  if (error instanceof StorageError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'BlobAccessError' || name === 'BlobStoreNotFoundError') {
    return new StorageError(
      'auth',
      `Vercel Blob refused to ${what}: check the store and its token.`,
    )
  }
  if (name === 'BlobServiceNotAvailable' || name === 'BlobServiceRateLimited') {
    return new StorageError('unavailable', `Vercel Blob couldn’t ${what} just now.`)
  }
  if (name === 'BlobStoreSuspendedError') {
    return new StorageError('rejected', 'The Vercel Blob store is suspended.')
  }
  return new StorageError('rejected', `Vercel Blob couldn’t ${what} (${name || 'error'}).`)
}

/** Keeps the bytes from `start` to `end` of a stream that sent the whole file anyway. */
function slice(body: ReadableStream<Uint8Array>, start: number, end: number) {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const from = Math.max(start - seen, 0)
        const to = Math.min(end + 1 - seen, chunk.byteLength)
        if (to > from) controller.enqueue(chunk.subarray(from, to))
        seen += chunk.byteLength
        // Everything asked for is out: the rest of the file isn't downloaded for nothing.
        if (seen > end) controller.terminate()
      },
    }),
  )
}

/**
 * Vercel Blob, through its own SDK: the one service here with no documented protocol to speak
 * without it. The SDK is loaded when the store is first used, never when the site starts.
 */
export function blobDriver(
  settings: () => BlobSettings,
  deps: { load?: () => Promise<BlobSdk>; fetch?: Fetch } = {},
): StorageDriver {
  const load = deps.load ?? (() => import('@vercel/blob'))
  const fetcher = deps.fetch ?? fetch
  const prefix = () => cleanPrefix(settings().prefix)
  const publicBase = () => {
    const current = settings()
    const storeId = blobStoreId(current)
    return current.access === 'public' && storeId
      ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com`
      : null
  }

  return {
    id: 'vercel-blob',
    label: 'Vercel Blob',
    directUploads: true,

    problem() {
      const current = settings()
      if (prefix() === null) return 'The folder may hold letters, digits, dots, dashes and slashes.'
      if (current.token) return null
      if (current.oidc && current.storeId) return null
      return 'Connect a Blob store to the project on Vercel, or set BLOB_READ_WRITE_TOKEN in the site’s environment.'
    },

    publicUrl(key) {
      const base = publicBase()
      return base && prefix() !== null ? `${base}/${prefix()}${key}` : null
    },

    async connect(): Promise<StorageConnection> {
      const blob = await load()
      // Read each time: a token rotated in the environment is used at once.
      const sign = () => {
        const { token, storeId } = settings()
        return token ? { token } : storeId ? { storeId } : {}
      }
      const path = (key: string) => {
        if (!isSafeKey(key)) throw new StorageError('rejected', 'That file’s name can’t be stored.')
        return `${prefix() ?? ''}${key}`
      }

      const stat = async (key: string) => {
        try {
          const found = await blob.head(path(key), sign())
          return { size: found.size, modifiedAt: found.uploadedAt }
        } catch (error) {
          if (isNotFound(error)) return null
          throw asStorageError('look a file up', error)
        }
      }

      return {
        stat,

        async create(key, data, contentType) {
          const { access, cacheSeconds } = settings()
          try {
            await blob.put(path(key), Buffer.from(data), {
              access,
              contentType,
              addRandomSuffix: false,
              allowOverwrite: false,
              cacheControlMaxAge: cacheSeconds,
              ...sign(),
            })
            return true
          } catch (error) {
            // The store refuses a taken name with an error it gives no class of its own.
            if (await stat(key).catch(() => null)) return false
            throw asStorageError('store a file', error)
          }
        },

        async read(key, range): Promise<StoredFile | null> {
          const headers = range ? { range: `bytes=${range.start}-${range.end}` } : undefined
          const address = publicBase()
          if (address) {
            const response = await request(fetcher, `${address}/${path(key)}`, {
              method: 'GET',
              headers: headers ?? {},
            })
            if (response.status === 404) {
              await response.body?.cancel().catch(() => {})
              return null
            }
            if (!response.ok || !response.body) {
              await response.body?.cancel().catch(() => {})
              throw new StorageError(
                'rejected',
                `Vercel Blob answered ${response.status} for a file.`,
              )
            }
            const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
            const partial = response.status === 206
            return {
              body:
                range && !partial ? slice(response.body, range.start, range.end) : response.body,
              size: Number(total ?? response.headers.get('content-length') ?? 0),
              modifiedAt: new Date(response.headers.get('last-modified') ?? Date.now()),
            }
          }
          try {
            const found = await blob.get(path(key), {
              access: 'private',
              ...(headers ? { headers } : {}),
              ...sign(),
            })
            if (!found || found.statusCode !== 200) return null
            const total = /\/(\d+)$/.exec(found.headers.get('content-range') ?? '')?.[1]
            return {
              body: range && !total ? slice(found.stream, range.start, range.end) : found.stream,
              size: Number(total ?? found.blob.size),
              modifiedAt: found.blob.uploadedAt,
            }
          } catch (error) {
            if (isNotFound(error)) return null
            throw asStorageError('read a file', error)
          }
        },

        async delete(key) {
          try {
            await blob.del(path(key), sign())
          } catch (error) {
            if (!isNotFound(error)) throw asStorageError('delete a file', error)
          }
        },

        async uploadTarget(key, { size, expiresAt }) {
          const { access } = settings()
          // Each address is its own grant: this path, this size, plain bytes, until it runs out.
          const limits = {
            pathname: path(key),
            validUntil: expiresAt.getTime(),
            maximumSizeInBytes: size,
            allowedContentTypes: [WAITING_TYPE],
          }
          try {
            const token = await blob.issueSignedToken({ ...limits, operations: ['put'], ...sign() })
            const { presignedUrl } = await blob.presignUrl(token, {
              ...limits,
              operation: 'put',
              access,
              allowOverwrite: false,
              addRandomSuffix: false,
              ttlDays: WAITING_DAYS,
            })
            return { url: presignedUrl, method: 'PUT', headers: { 'content-type': WAITING_TYPE } }
          } catch (error) {
            throw asStorageError('sign an upload', error)
          }
        },
      }
    },
  }
}
