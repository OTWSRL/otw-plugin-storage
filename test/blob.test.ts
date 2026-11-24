import { describe, expect, it } from 'vitest'
import { StorageError } from '../src/http'
import { blobDriver, blobStoreId, type BlobSdk, type BlobSettings } from '../src/vercel-blob'

const bytes = (value: string) => new TextEncoder().encode(value)
const TOKEN = 'vercel_blob_rw_AbC123xyz_secretpartofthetoken'

const settings = (changes: Partial<BlobSettings> = {}): BlobSettings => ({
  access: 'public',
  token: TOKEN,
  storeId: undefined,
  oidc: false,
  prefix: '',
  cacheSeconds: 86_400,
  ...changes,
})

class NamedError extends Error {
  constructor(name: string, message = name) {
    super(message)
    this.name = name
  }
}

/** A store in memory behind the SDK's own calls, recording what it was asked. */
function fakeSdk() {
  const files = new Map<string, { data: Uint8Array; type: string }>()
  const calls: { name: string; path: string; options: Record<string, unknown> }[] = []
  const record = (name: string, path: string, options: object) =>
    calls.push({ name, path, options: options as Record<string, unknown> })
  const sdk = {
    async put(path: string, body: unknown, options: Record<string, unknown>) {
      record('put', path, options)
      if (files.has(path) && options.allowOverwrite !== true) {
        throw new NamedError('BlobError', 'Vercel Blob: This blob already exists')
      }
      files.set(path, { data: new Uint8Array(body as Buffer), type: String(options.contentType) })
      return {}
    },
    async head(path: string, options: object) {
      record('head', path, options)
      const file = files.get(path)
      if (!file) throw new NamedError('BlobNotFoundError')
      return { size: file.data.byteLength, uploadedAt: new Date('2026-11-24T10:00:00Z') }
    },
    async get(path: string, options: Record<string, unknown>) {
      record('get', path, options)
      const file = files.get(path)
      if (!file) return null
      // As a store that sends the whole file whatever range was asked for.
      return {
        statusCode: 200,
        stream: new Blob([file.data as BlobPart]).stream(),
        headers: new Headers(),
        blob: { size: file.data.byteLength, uploadedAt: new Date('2026-11-24T10:00:00Z') },
      }
    },
    async del(path: string, options: object) {
      record('del', path, options)
      files.delete(path)
    },
    async issueSignedToken(options: Record<string, unknown>) {
      record('issueSignedToken', String(options.pathname), options)
      return { delegationToken: 'delegation', clientSigningToken: 'signing', validUntil: 0 }
    },
    async presignUrl(token: unknown, options: Record<string, unknown>) {
      record('presignUrl', String(options.pathname), { ...options, token })
      return { presignedUrl: `https://blob.vercel-storage.com/?pathname=${options.pathname}&sig=1` }
    },
  }
  return { sdk: sdk as unknown as BlobSdk, files, calls }
}

async function connect(changes: Partial<BlobSettings> = {}, fetcher?: typeof fetch) {
  const fake = fakeSdk()
  const driver = blobDriver(() => settings(changes), {
    load: async () => fake.sdk,
    ...(fetcher ? { fetch: fetcher } : {}),
  })
  return { ...fake, driver, connection: await driver.connect() }
}

describe('a Vercel Blob store', () => {
  it('finds its id in the token, or in the environment', () => {
    expect(blobStoreId({ token: TOKEN, storeId: undefined })).toBe('AbC123xyz')
    expect(blobStoreId({ token: undefined, storeId: 'store_Zz9' })).toBe('Zz9')
    // With both, the token's: it's the store the SDK writes to, so files are linked there too.
    expect(blobStoreId({ token: TOKEN, storeId: 'store_Other1' })).toBe('AbC123xyz')
    expect(blobStoreId({ token: 'not-a-blob-token', storeId: undefined })).toBeNull()
  })

  it('is ready with a token, or with Vercel’s own sign-in and the store’s id', () => {
    const problem = (changes: Partial<BlobSettings>) =>
      blobDriver(() => settings(changes)).problem()
    expect(problem({})).toBeNull()
    expect(problem({ token: undefined, oidc: true, storeId: 'store_Zz9' })).toBeNull()
    expect(problem({ token: undefined })).toContain('BLOB_READ_WRITE_TOKEN')
    expect(problem({ token: undefined, oidc: true })).toContain('BLOB_READ_WRITE_TOKEN')
    expect(problem({ prefix: '../up' })).toContain('The folder may hold')
  })

  it('gives a public store’s files their own address, and a private store’s the site’s', () => {
    const driver = (changes: Partial<BlobSettings>) => blobDriver(() => settings(changes))
    expect(driver({ prefix: 'site' }).publicUrl('2026/11/a.jpg')).toBe(
      'https://abc123xyz.public.blob.vercel-storage.com/site/2026/11/a.jpg',
    )
    expect(driver({ access: 'private' }).publicUrl('2026/11/a.jpg')).toBeNull()
  })

  it('never loads the SDK until a file is asked for', async () => {
    let loaded = 0
    const driver = blobDriver(() => settings(), {
      load: async () => {
        loaded++
        return fakeSdk().sdk
      },
    })
    driver.problem()
    driver.publicUrl('a.jpg')
    expect(loaded).toBe(0)
    await driver.connect()
    expect(loaded).toBe(1)
  })
})

describe('files in the store', () => {
  it('stores a file under its own name, never a random one, never over another', async () => {
    const { connection, calls, files } = await connect({ prefix: 'site', cacheSeconds: 2_592_000 })
    expect(await connection.create('2026/11/a.jpg', bytes('first'), 'image/jpeg')).toBe(true)
    expect(calls[0]).toMatchObject({
      name: 'put',
      path: 'site/2026/11/a.jpg',
      options: {
        access: 'public',
        contentType: 'image/jpeg',
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 2_592_000,
        token: TOKEN,
      },
    })
    expect(await connection.create('2026/11/a.jpg', bytes('second'), 'image/jpeg')).toBe(false)
    expect(new TextDecoder().decode(files.get('site/2026/11/a.jpg')!.data)).toBe('first')
  })

  it('looks a file up and deletes it, a missing one without complaint', async () => {
    const { connection } = await connect()
    expect(await connection.stat('a.txt')).toBeNull()
    await connection.create('a.txt', bytes('hello'), 'text/plain')
    expect(await connection.stat('a.txt')).toEqual({
      size: 5,
      modifiedAt: new Date('2026-11-24T10:00:00Z'),
    })
    await connection.delete('a.txt')
    await connection.delete('a.txt')
    expect(await connection.stat('a.txt')).toBeNull()
  })

  it('reads a public store’s file from its address, ranges included', async () => {
    const asked: { url: string; range: string | null }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get('range')
      asked.push({ url, range })
      if (url.endsWith('/missing.txt')) return new Response(null, { status: 404 })
      return range
        ? new Response('234', { status: 206, headers: { 'content-range': 'bytes 2-4/10' } })
        : new Response('0123456789', { headers: { 'content-length': '10' } })
    }) as typeof fetch
    const { connection } = await connect({}, fetcher)
    const whole = await connection.read('a.txt')
    expect(whole!.size).toBe(10)
    expect(await new Response(whole!.body).text()).toBe('0123456789')
    const part = await connection.read('a.txt', { start: 2, end: 4 })
    expect(part!.size).toBe(10)
    expect(await new Response(part!.body).text()).toBe('234')
    expect(await connection.read('missing.txt')).toBeNull()
    expect(asked[1]).toEqual({
      url: 'https://abc123xyz.public.blob.vercel-storage.com/a.txt',
      range: 'bytes=2-4',
    })
  })

  it('reads a private store’s file through the SDK, cutting a range out if it sends the whole', async () => {
    const { connection, calls } = await connect({ access: 'private' })
    await connection.create('a.txt', bytes('0123456789'), 'text/plain')
    const part = await connection.read('a.txt', { start: 2, end: 4 })
    expect(part!.size).toBe(10)
    expect(await new Response(part!.body).text()).toBe('234')
    expect(calls.at(-1)).toMatchObject({
      name: 'get',
      options: { access: 'private', headers: { range: 'bytes=2-4' }, token: TOKEN },
    })
    expect(await connection.read('missing.txt')).toBeNull()
  })

  it('stops reading a file once the range asked for is out', async () => {
    let sent = 0
    const fake = fakeSdk()
    ;(fake.sdk as { get: unknown }).get = async () => ({
      statusCode: 200,
      // A store that sends the whole file, a kilobyte at a time, for as long as it's read.
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          sent++
          controller.enqueue(new Uint8Array(1024).fill(65))
          if (sent > 500) controller.close()
        },
      }),
      headers: new Headers(),
      blob: { size: 500 * 1024, uploadedAt: new Date() },
    })
    const driver = blobDriver(() => settings({ access: 'private' }), { load: async () => fake.sdk })
    const part = await (await driver.connect()).read('big.bin', { start: 0, end: 9 })
    expect(await new Response(part!.body).text()).toBe('AAAAAAAAAA')
    expect(sent).toBeLessThan(10)
  })

  it('refuses a name that could leave its folder', async () => {
    const { connection, calls } = await connect({ prefix: 'site' })
    await expect(connection.stat('../other/a.txt')).rejects.toMatchObject({ name: 'StorageError' })
    await expect(connection.create('a?b', bytes('x'), 'text/plain')).rejects.toMatchObject({
      name: 'StorageError',
    })
    expect(calls).toEqual([])
  })

  it('signs an address for one file of one size, as plain bytes, kept a day at most', async () => {
    const { connection, calls } = await connect({ prefix: 'site' })
    const expiresAt = new Date('2026-11-24T10:15:00Z')
    const target = await connection.uploadTarget!('_uploads/abc', { size: 5_000_000, expiresAt })
    expect(target).toEqual({
      url: 'https://blob.vercel-storage.com/?pathname=site/_uploads/abc&sig=1',
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    })
    const limits = {
      pathname: 'site/_uploads/abc',
      validUntil: expiresAt.getTime(),
      maximumSizeInBytes: 5_000_000,
      allowedContentTypes: ['application/octet-stream'],
    }
    expect(calls[0]).toMatchObject({
      name: 'issueSignedToken',
      options: { ...limits, operations: ['put'], token: TOKEN },
    })
    expect(calls[1]).toMatchObject({
      name: 'presignUrl',
      options: {
        ...limits,
        operation: 'put',
        access: 'public',
        allowOverwrite: false,
        addRandomSuffix: false,
        ttlDays: 1,
      },
    })
  })

  it('says what went wrong in its own words, without the SDK’s', async () => {
    const { connection, sdk } = await connect()
    ;(sdk as { head: unknown }).head = async () => {
      throw new NamedError('BlobAccessError', `Access denied for ${TOKEN}`)
    }
    const error = await connection.stat('a.txt').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StorageError)
    expect(error).toMatchObject({ code: 'auth' })
    expect((error as Error).message).not.toContain(TOKEN)
  })
})
