import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CACHE_CONTROL, type S3Config } from '../src/config'
import { StorageError } from '../src/http'
import { s3Connection } from '../src/s3'
import { KEYS, startFakeS3, type FakeS3 } from './fake-s3'

const bytes = (value: string) => new TextEncoder().encode(value)
const text = async (file: { body: ReadableStream<Uint8Array> } | null) =>
  file ? new Response(file.body).text() : null

let s3: FakeS3
beforeAll(async () => {
  s3 = await startFakeS3()
})
beforeEach(() => s3.clear())

const config = (changes: Partial<S3Config> = {}): S3Config => ({
  base: `${s3.url}/media`,
  region: 'us-east-1',
  credentials: KEYS,
  noOverwrite: 'header',
  prefix: '',
  cacheControl: CACHE_CONTROL.day,
  publicUrl: null,
  ...changes,
})

/** The lock a site gives it, recording what it was asked to keep apart. */
function connect(changes: Partial<S3Config> = {}, now?: () => Date) {
  const locked: string[] = []
  const connection = s3Connection(config(changes), {
    fetch,
    claim: async (key, write) => {
      locked.push(key)
      return write()
    },
    ...(now ? { now } : {}),
  })
  return { connection, locked }
}

describe('files in a bucket', () => {
  it('stores a file with its type, how long to cache it, and whether it shows or downloads', async () => {
    const { connection } = connect({ prefix: 'site/' })
    expect(await connection.create('2026/11/photo.jpg', bytes('jpeg'), 'image/jpeg')).toBe(true)
    expect(await connection.create('2026/11/setup.zip', bytes('zip'), 'application/zip')).toBe(true)
    expect(await s3.objects()).toEqual([
      {
        key: 'media/site/2026/11/photo.jpg',
        size: 4,
        type: 'image/jpeg',
        cache: 'public, max-age=86400',
        disposition: 'inline',
      },
      {
        key: 'media/site/2026/11/setup.zip',
        size: 3,
        type: 'application/zip',
        cache: 'public, max-age=86400',
        disposition: 'attachment',
      },
    ])
  })

  it('reads a file whole or in part, and says how large the whole is', async () => {
    const { connection } = connect()
    await connection.create('notes.txt', bytes('0123456789'), 'text/plain')
    const whole = await connection.read('notes.txt')
    expect(whole).toMatchObject({ size: 10 })
    expect(whole!.modifiedAt).toBeInstanceOf(Date)
    expect(await text(whole)).toBe('0123456789')
    const part = await connection.read('notes.txt', { start: 2, end: 5 })
    expect(part!.size).toBe(10)
    expect(await text(part)).toBe('2345')
    expect(await connection.stat('notes.txt')).toMatchObject({ size: 10 })
  })

  it('answers nothing for a file that isn’t there, and deletes without complaint', async () => {
    const { connection } = connect()
    expect(await connection.read('missing.txt')).toBeNull()
    expect(await connection.stat('missing.txt')).toBeNull()
    await connection.delete('missing.txt')
    await connection.create('here.txt', bytes('x'), 'text/plain')
    await connection.delete('here.txt')
    expect(await connection.stat('here.txt')).toBeNull()
  })
})

describe('never writing over a file', () => {
  it('lets the service refuse the second write, where it does', async () => {
    const { connection, locked } = connect({ noOverwrite: 'header' })
    expect(await connection.create('photo.jpg', bytes('first'), 'image/jpeg')).toBe(true)
    expect(await connection.create('photo.jpg', bytes('second'), 'image/jpeg')).toBe(false)
    expect(await text(await connection.read('photo.jpg'))).toBe('first')
    expect(locked).toEqual([])
  })

  it('looks first, under a lock, where the service would write over it', async () => {
    await s3.control({ conditional: 'ignore' })
    const { connection, locked } = connect({ noOverwrite: 'check', prefix: 'site/' })
    expect(await connection.create('photo.jpg', bytes('first'), 'image/jpeg')).toBe(true)
    expect(await connection.create('photo.jpg', bytes('second'), 'image/jpeg')).toBe(false)
    expect(await text(await connection.read('photo.jpg'))).toBe('first')
    // One lock per file, named by the bucket too: two sites' buckets don't wait on each other.
    expect(locked).toEqual([`${s3.url}/media/site/photo.jpg`, `${s3.url}/media/site/photo.jpg`])
  })

  it('works on a service that refuses the header, by looking first', async () => {
    await s3.control({ conditional: 'reject' })
    const checking = connect({ noOverwrite: 'check' }).connection
    expect(await checking.create('a.txt', bytes('a'), 'text/plain')).toBe(true)
    expect(await checking.create('a.txt', bytes('b'), 'text/plain')).toBe(false)
    // Trusting the header there fails loudly, rather than writing over anything.
    const trusting = connect({ noOverwrite: 'header' }).connection
    await expect(trusting.create('b.txt', bytes('b'), 'text/plain')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'unavailable',
      status: 501,
      reason: 'NotImplemented',
    })
  })
})

describe('names that could climb out of the bucket', () => {
  it('are refused before any request is made', async () => {
    const seen: string[] = []
    const connection = s3Connection(config({ prefix: 'site/' }), {
      fetch: (async (url: string) => {
        seen.push(url)
        return new Response(null, { status: 200 })
      }) as never,
      claim: (_key, write) => write(),
    })
    for (const key of [
      '../other/a.txt',
      'a/%2e%2e/b.txt',
      'a.txt?versionId=1',
      'a.txt#x',
      '.env',
      '',
    ]) {
      await expect(connection.stat(key)).rejects.toMatchObject({ name: 'StorageError' })
      await expect(connection.read(key)).rejects.toMatchObject({ name: 'StorageError' })
      await expect(connection.delete(key)).rejects.toMatchObject({ name: 'StorageError' })
      await expect(connection.create(key, bytes('x'), 'text/plain')).rejects.toMatchObject({
        name: 'StorageError',
      })
    }
    expect(seen).toEqual([])
  })

  it('treats a name another upload is writing this moment as taken', async () => {
    await s3.control({ conditional: 'ignore' })
    const connection = s3Connection(config({ noOverwrite: 'check' }), {
      fetch,
      claim: async () => false,
    })
    expect(await connection.create('photo.jpg', bytes('second'), 'image/jpeg')).toBe(false)
    expect(await s3.objects()).toEqual([])
  })
})

describe('what goes wrong', () => {
  it('says the keys are refused, with the service’s own word and nothing secret', async () => {
    const { connection } = connect({
      credentials: { ...KEYS, secretAccessKey: 'not-the-secret-key' },
    })
    const error = await connection.stat('a.txt').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StorageError)
    expect(error).toMatchObject({ code: 'auth', status: 403, retryable: false })
    const failed = await connection
      .create('a.txt', bytes('a'), 'text/plain')
      .catch((caught: unknown) => caught as StorageError)
    expect(failed).toMatchObject({ code: 'auth', reason: 'SignatureDoesNotMatch' })
    expect((failed as StorageError).message).toBe(
      'The storage refused to store a file (403, SignatureDoesNotMatch).',
    )
    expect(JSON.stringify(failed)).not.toContain('not-the-secret-key')
  })

  it('says the service can’t be reached, without its address', async () => {
    const { connection } = connect({ base: 'http://127.0.0.1:9/media' })
    const error = (await connection
      .stat('a.txt')
      .catch((caught: unknown) => caught)) as StorageError
    expect(error).toMatchObject({ code: 'network', retryable: true })
    expect(error.message).toBe('The storage couldn’t be reached.')
    expect(error.cause).toBeUndefined()
  })

  it('never follows a redirect with its signed headers', async () => {
    const seen: RequestInit[] = []
    const connection = s3Connection(config(), {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init)
        return new Response(null, { status: 200, headers: { 'content-length': '0' } })
      }) as never,
      claim: (_key, write) => write(),
    })
    await connection.stat('a.txt')
    expect(seen[0]).toMatchObject({ redirect: 'error', method: 'HEAD' })
  })
})

describe('an address for a browser’s upload', () => {
  const waiting = '_uploads/3f0e4a9e-7d0c-4f5e-9a51-0f6b8f6f2c11'
  const data = bytes('five megabytes, say')
  const later = () => new Date(Date.now() + 15 * 60_000)

  it('takes the one file it was signed for, as plain bytes', async () => {
    const { connection } = connect({ prefix: 'site/' })
    const target = await connection.uploadTarget!(waiting, {
      size: data.byteLength,
      expiresAt: later(),
    })
    expect(target.method).toBe('PUT')
    expect(target.headers).toEqual({ 'content-type': 'application/octet-stream' })
    expect(target.url).toContain(`/media/site/${waiting}?`)
    // The secret key signs the address; it's never part of it.
    expect(target.url).not.toContain(KEYS.secretAccessKey)

    const sent = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: data as BodyInit,
    })
    expect(sent.status).toBe(200)
    expect(await s3.objects()).toMatchObject([
      { key: `media/site/${waiting}`, size: data.byteLength, type: 'application/octet-stream' },
    ])
    expect(await text(await connection.read(waiting))).toBe('five megabytes, say')
  })

  it('takes no other size, type, key or method', async () => {
    const { connection } = connect()
    const target = await connection.uploadTarget!(waiting, {
      size: data.byteLength,
      expiresAt: later(),
    })
    const put = (url: string, headers: Record<string, string>, body: Uint8Array, method = 'PUT') =>
      fetch(url, { method, headers, body: body as BodyInit }).then((response) => response.status)

    expect(await put(target.url, target.headers, bytes('a longer file than was signed for'))).toBe(
      403,
    )
    expect(await put(target.url, { 'content-type': 'text/html' }, data)).toBe(403)
    expect(await put(target.url.replace(waiting, '2026/11/photo.jpg'), target.headers, data)).toBe(
      403,
    )
    expect(await put(target.url, target.headers, data, 'POST')).toBe(403)
    expect(await fetch(target.url).then((response) => response.status)).toBe(403)
    expect(await s3.objects()).toEqual([])
  })

  it('stops working when it runs out', async () => {
    // Signed twenty minutes ago, for fifteen.
    const then = new Date(Date.now() - 20 * 60_000)
    const { connection } = connect({}, () => then)
    const target = await connection.uploadTarget!(waiting, {
      size: data.byteLength,
      expiresAt: new Date(then.getTime() + 15 * 60_000),
    })
    const sent = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: data as BodyInit,
    })
    expect(sent.status).toBe(403)
  })
})
