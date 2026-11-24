import type { StoredFile } from '@otwdesign/sdk'
import { dispositionFor, type S3Config } from './config'
import type { StorageConnection } from './drivers'
import { refusal, request, SEND_TIMEOUT_MS, StorageError, type Fetch } from './http'
import { presignUrl, sha256Hex, signHeaders } from './sigv4'

/** SHA-256 of nothing: what a request without a body says its body is. */
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
/** What a browser's upload is kept as until the site has read it: never a page or a script. */
const WAITING_TYPE = 'application/octet-stream'
/** Tries at a write the service says is racing another on the same key. */
const CONFLICT_TRIES = 3

export interface S3Dependencies {
  fetch: Fetch
  /**
   * Runs `fn` while nothing else, on this server or another, runs under the same key: what
   * keeps two uploads of one name apart on services that don't themselves.
   */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>
  now?: () => Date
}

/** A bucket on S3 or a service that speaks its protocol, over plain `fetch`. */
export function s3Connection(config: S3Config, deps: S3Dependencies): StorageConnection {
  const now = deps.now ?? (() => new Date())
  const objectUrl = (key: string) => new URL(`${config.base}/${config.prefix}${key}`)

  const send = async (
    method: string,
    key: string,
    headers: Record<string, string> = {},
    body?: Uint8Array,
  ) => {
    const url = objectUrl(key)
    const signed = await signHeaders({
      method,
      url,
      headers,
      payloadHash: body ? await sha256Hex(body) : EMPTY_HASH,
      credentials: config.credentials,
      region: config.region,
      now: now(),
    })
    return request(
      deps.fetch,
      url.href,
      { method, headers: signed, ...(body ? { body } : {}) },
      body ? SEND_TIMEOUT_MS : undefined,
    )
  }

  /** Nothing is read from an answer that only says yes or no; its connection is freed. */
  const done = (response: Response) => response.body?.cancel().catch(() => {})

  const stat = async (key: string) => {
    const response = await send('HEAD', key)
    await done(response)
    if (response.status === 404) return null
    if (!response.ok) throw await refusal('look a file up', response)
    return {
      size: Number(response.headers.get('content-length') ?? 0),
      modifiedAt: new Date(response.headers.get('last-modified') ?? Date.now()),
    }
  }

  const put = async (key: string, data: Uint8Array, contentType: string, onlyIfNew: boolean) => {
    for (let attempt = 1; ; attempt++) {
      const response = await send(
        'PUT',
        key,
        {
          'content-type': contentType,
          'cache-control': config.cacheControl,
          'content-disposition': dispositionFor(contentType),
          ...(onlyIfNew ? { 'if-none-match': '*' } : {}),
        },
        data,
      )
      if (response.ok) {
        await done(response)
        return true
      }
      // Taken: by a file already there, or by one that won a race this instant.
      if (onlyIfNew && response.status === 412) {
        await done(response)
        return false
      }
      // Another write to the same key was under way: S3 asks for the request again.
      if (onlyIfNew && response.status === 409 && attempt < CONFLICT_TRIES) {
        await done(response)
        continue
      }
      throw await refusal('store a file', response)
    }
  }

  return {
    stat,

    create(key, data, contentType) {
      if (config.noOverwrite === 'header') return put(key, data, contentType, true)
      return deps.lock(`${config.base}/${config.prefix}${key}`, async () => {
        if (await stat(key)) return false
        return put(key, data, contentType, false)
      })
    },

    async read(key, range): Promise<StoredFile | null> {
      const response = await send(
        'GET',
        key,
        range ? { range: `bytes=${range.start}-${range.end}` } : {},
      )
      if (response.status === 404) {
        await done(response)
        return null
      }
      if (!response.ok || !response.body) throw await refusal('read a file', response)
      // A range's answer says the whole file's size after the slash: "bytes 0-9/1234".
      const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
      return {
        body: response.body,
        size: Number(total ?? response.headers.get('content-length') ?? 0),
        modifiedAt: new Date(response.headers.get('last-modified') ?? Date.now()),
      }
    },

    async delete(key) {
      const response = await send('DELETE', key)
      await done(response)
      if (!response.ok && response.status !== 404) throw await refusal('delete a file', response)
    },

    async uploadTarget(key, { size, expiresAt }) {
      // What the browser must send is part of what's signed: this key, this type, this length.
      const headers = { 'content-type': WAITING_TYPE }
      const url = await presignUrl({
        method: 'PUT',
        url: objectUrl(key),
        headers: { ...headers, 'content-length': String(size) },
        credentials: config.credentials,
        region: config.region,
        expiresInSeconds: (expiresAt.getTime() - now().getTime()) / 1000,
        now: now(),
      })
      return { url, method: 'PUT', headers }
    },
  }
}

export { StorageError }
