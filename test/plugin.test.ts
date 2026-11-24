import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { definePlugin, type MediaItem } from '@otwdesign/sdk'
import { TEST_ORIGIN } from '@otwdesign/testing'
import type { Kernel } from '@otwdesign/core'
import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageConnection, StorageDriver } from '../src/index'
import { DIRECT_FROM_BYTES } from '../src/index'
import { startFakeS3, type FakeS3 } from './fake-s3'
import { bootStorage, bucketEnv, bucketSettings, bytes, privateEnv } from './fixtures'

let s3: FakeS3
beforeAll(async () => {
  s3 = await startFakeS3()
})
beforeEach(() => s3.clear())

const photo = async () =>
  new Uint8Array(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2271b1' } })
      .jpeg()
      .toBuffer(),
  )
const on = () => ({ ...bucketSettings(s3), 'storage.active': true })
const keys = async () => (await s3.objects()).map((object) => object.key).sort()

/** Where an admin form's post went, and what it said. */
function outcome(kernel: Kernel, response: Response) {
  const url = new URL(response.headers.get('location') ?? '', TEST_ORIGIN)
  const flash = kernel.readFlash(url.searchParams.get('flash') ?? undefined)
  return { path: url.pathname, kind: flash?.kind, message: flash?.message ?? '' }
}

describe('switched off, as it starts', () => {
  it('leaves uploads on the disk, and the site as it was', async () => {
    const { kernel, uploads } = await bootStorage({ settings: bucketSettings(s3), env: bucketEnv })
    expect(kernel.directUploads).toBeNull()
    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('on disk') })
    expect(item.url).toBe(`/uploads/${item.file}`)
    expect(readdirSync(uploads, { recursive: true }).join()).toContain('notes.txt')
    expect(await s3.objects()).toEqual([])
    expect(kernel.service('storage').status()).toEqual({
      active: false,
      driver: 's3',
      problem: null,
    })
  })

  it('asks nothing of the storage while the site starts, even switched on', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch')
    const { kernel } = await bootStorage({ settings: on(), env: bucketEnv })
    // Pages ask where files are: that's worked out, not looked up.
    expect(kernel.directUploads).toEqual({ minBytes: DIRECT_FROM_BYTES })
    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
  })
})

describe('switched on', () => {
  it('keeps an upload and its sizes in the bucket, and serves them through the site', async () => {
    const { kernel } = await bootStorage({ settings: on(), env: bucketEnv })
    const item = await kernel.media.upload({ name: 'Beach.jpg', data: await photo() })
    expect(item.url).toBe(`/uploads/${item.file}`)
    const stored = await s3.objects()
    expect(stored.map((object) => object.key)).toContain(`media/${item.file}`)
    expect(stored.map((object) => object.key)).toContain(`media/${item.sizes.thumbnail!.file}`)
    expect(stored.every((object) => object.type === 'image/jpeg')).toBe(true)
    expect(stored.every((object) => object.cache === 'public, max-age=86400')).toBe(true)

    const served = await kernel.serveUpload(
      new Request(new URL(item.url, TEST_ORIGIN), { headers: { range: 'bytes=0-2' } }),
      item.file,
    )
    expect(served.status).toBe(206)
    expect(served.headers.get('content-range')).toMatch(/^bytes 0-2\/\d+$/)
    // A JPEG's first bytes.
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff])

    await kernel.media.delete(item.id)
    expect(await s3.objects()).toEqual([])
  })

  it('gives files their public address when the bucket has one', async () => {
    const { kernel } = await bootStorage({
      settings: {
        ...on(),
        'storage.public_url': 'https://media.example.com/',
        'storage.prefix': 'site',
        'storage.cache': 'year',
      },
      env: bucketEnv,
    })
    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('public') })
    expect(item.url).toBe(`https://media.example.com/site/${item.file}`)
    expect(await s3.objects()).toMatchObject([
      { key: `media/site/${item.file}`, cache: 'public, max-age=31536000' },
    ])
  })

  it.each(['check', 'header'])(
    'numbers a second file of the same name, never writing over the first (%s)',
    async (mode) => {
      const { kernel } = await bootStorage({
        settings: { ...on(), 'storage.s3_no_overwrite': mode },
        env: bucketEnv,
      })
      const [first, second] = await Promise.all([
        kernel.media.upload({ name: 'notes.txt', data: bytes('first') }),
        kernel.media.upload({ name: 'notes.txt', data: bytes('second') }),
      ])
      expect([first.file, second.file].map((file) => file.split('/').pop()).sort()).toEqual([
        'notes-1.txt',
        'notes.txt',
      ])
      expect(await keys()).toHaveLength(2)
      // No name is left claimed once its file is written.
      const claims = (await kernel.db.execute('SELECT key FROM storage_claims')) as never as {
        rows: unknown[]
      }
      expect(claims.rows).toEqual([])
    },
  )

  it('takes over a claim left by a server that stopped, once it has run out', async () => {
    const { kernel } = await bootStorage({ settings: on(), env: bucketEnv })
    const month = `${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`
    const claimed = `${s3.url}/media/${month}/notes.txt`
    await kernel.db.execute(
      `INSERT INTO storage_claims (key, expires_at) VALUES ('${claimed}', now() + interval '5 minutes')`,
    )
    // Being written, as far as anyone can tell: the upload takes the next name.
    const waiting = await kernel.media.upload({ name: 'notes.txt', data: bytes('second') })
    expect(waiting.file.endsWith('/notes-1.txt')).toBe(true)
    await kernel.db.execute(`UPDATE storage_claims SET expires_at = now() - interval '1 minute'`)
    const after = await kernel.media.upload({ name: 'notes.txt', data: bytes('first after all') })
    expect(after.file.endsWith('/notes.txt')).toBe(true)
  })

  it('fails each upload with what’s missing, and never falls back to the disk', async () => {
    const { kernel, uploads } = await bootStorage({ settings: on(), env: privateEnv })
    expect(kernel.directUploads).toBeNull()
    await expect(kernel.media.upload({ name: 'notes.txt', data: bytes('x') })).rejects.toThrow(
      'The media storage isn’t ready: Set STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY in the site’s environment.',
    )
    expect(readdirSync(uploads)).toEqual([])
    expect(kernel.service('storage').status()).toMatchObject({
      active: true,
      problem: expect.stringContaining('STORAGE_S3_ACCESS_KEY_ID'),
    })
  })

  it('sends browsers’ files straight to the bucket, as the setting says', async () => {
    const direct = async (choice: string) =>
      (
        await bootStorage({
          settings: { ...on(), 'storage.direct_uploads': choice },
          env: bucketEnv,
        })
      ).kernel.directUploads
    expect(await direct('large')).toEqual({ minBytes: 4 * 1024 * 1024 })
    expect(await direct('always')).toEqual({ minBytes: 0 })
    expect(await direct('off')).toBeNull()
  })

  it('takes a file from the browser at a signed address and stores it as any upload', async () => {
    const { harness, kernel, admin } = await bootStorage({ settings: on(), env: bucketEnv })
    const data = await photo()
    const begun = await harness.request('POST', '/api/p/core/media/uploads', {
      json: { name: 'Harbour.jpg', size: data.byteLength },
      cookie: admin.cookie,
    })
    expect(begun.status).toBe(201)
    const target = (await begun.json()) as {
      id: string
      url: string
      headers: Record<string, string>
    }
    expect(await keys()).toEqual([])

    // The browser's part: the bytes go to the bucket, not to the site.
    const sent = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: data as BodyInit,
    })
    expect(sent.status).toBe(200)
    expect(await keys()).toEqual([`media/_uploads/${target.id}`])

    const done = await harness.request('POST', `/api/p/core/media/uploads/${target.id}/complete`, {
      cookie: admin.cookie,
    })
    expect(done.status).toBe(201)
    const item = (await done.json()) as MediaItem
    expect(item).toMatchObject({ mimeType: 'image/jpeg', width: 800, height: 600 })
    const stored = await keys()
    expect(stored).toContain(`media/${item.file}`)
    // The file that waited is gone; only the upload and its sizes are left.
    expect(stored.some((key) => key.includes('_uploads/'))).toBe(false)
    expect((await kernel.media.list()).total).toBe(1)
  })
})

describe('addresses inside the server’s own network', () => {
  it('are never asked for anything unless the server itself allows them', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch')
    const { kernel, act } = await bootStorage({
      settings: on(),
      env: { STORAGE_S3_ACCESS_KEY_ID: 'k', STORAGE_S3_SECRET_ACCESS_KEY: 's' },
    })
    const problem = kernel.service('storage').status().problem
    expect(problem).toContain('That address is on the server’s own network.')
    await expect(kernel.media.upload({ name: 'a.txt', data: bytes('x') })).rejects.toThrow(
      'The media storage isn’t ready',
    )
    // Anyone may ask the site for /uploads/…: with the storage refused, nothing is fetched.
    await expect(
      kernel.serveUpload(
        new Request(new URL('/uploads/v1/agent/self', TEST_ORIGIN)),
        'v1/agent/self',
      ),
    ).rejects.toThrow('The media storage isn’t ready')
    expect(outcome(kernel, await act('test-connection')).message).toContain(
      'Finish the settings: That address is on the server’s own network.',
    )
    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
  })

  it('never reaches a cloud’s metadata address, even with private addresses allowed', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch')
    const { kernel, act } = await bootStorage({
      settings: {
        ...on(),
        'storage.s3_endpoint': 'http://169.254.169.254',
        'storage.s3_bucket': 'latest',
        'storage.prefix': 'meta-data/iam',
      },
      env: bucketEnv,
    })
    expect(kernel.service('storage').status().problem).toBe(
      'That address isn’t a storage service’s.',
    )
    await expect(
      kernel.serveUpload(
        new Request(new URL('/uploads/security-credentials', TEST_ORIGIN)),
        'security-credentials',
      ),
    ).rejects.toThrow('The media storage isn’t ready')
    expect(outcome(kernel, await act('test-connection')).kind).toBe('error')
    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
  })
})

describe('a driver another plugin adds', () => {
  it('is used when Settings › Storage says so', async () => {
    const files = new Map<string, Uint8Array>()
    const connection: StorageConnection = {
      create: async (key, data) => !files.has(key) && Boolean(files.set(key, data)),
      read: async () => null,
      stat: async (key) =>
        files.has(key) ? { size: files.get(key)!.byteLength, modifiedAt: new Date() } : null,
      delete: async (key) => void files.delete(key),
    }
    const shelf: StorageDriver = {
      id: 'shelf',
      label: 'A shelf',
      directUploads: false,
      problem: () => null,
      publicUrl: (key) => `https://shelf.example/${key}`,
      connect: async () => connection,
    }
    const adds = definePlugin({
      id: 'shelf',
      version: '1.0.0',
      requires: { storage: '*' },
      setup(cms) {
        cms.registries.get('storage.drivers').add(shelf)
      },
    })
    const { kernel } = await bootStorage({
      settings: { 'storage.active': true, 'storage.driver': 'plugin' },
      plugins: [adds],
    })
    const item = await kernel.media.upload({ name: 'notes.txt', data: bytes('shelved') })
    expect(item.url).toBe(`https://shelf.example/${item.file}`)
    expect([...files.keys()]).toEqual([item.file])
    expect(kernel.directUploads).toBeNull()
    expect(kernel.service('storage').status()).toMatchObject({ driver: 'shelf' })
  })

  it('says so when no plugin has added one', async () => {
    const { kernel } = await bootStorage({
      settings: { 'storage.active': true, 'storage.driver': 'plugin' },
    })
    expect(kernel.service('storage').status().problem).toBe(
      'No plugin has added a storage driver. Choose another, or install one.',
    )
  })
})

describe('testing the connection', () => {
  it('passes a bucket that does everything, uploads from the site’s pages included', async () => {
    const { kernel, act } = await bootStorage({ settings: bucketSettings(s3), env: bucketEnv })
    const done = outcome(kernel, await act('test-connection'))
    expect(done).toMatchObject({ kind: 'notice', message: 'The storage passed all 8 checks.' })
    // It leaves nothing behind.
    expect(await s3.objects()).toEqual([])
  })

  it('says when the bucket’s CORS rules keep browsers out', async () => {
    await s3.control({ cors: false })
    const { kernel, act } = await bootStorage({ settings: bucketSettings(s3), env: bucketEnv })
    const done = outcome(kernel, await act('test-connection'))
    expect(done.kind).toBe('error')
    expect(done.message).toContain('1 of 8 checks failed. Take an upload at a signed address')
    expect(done.message).toContain('CORS rules don’t let https://site.example send files')
    expect(await s3.objects()).toEqual([])
  })

  it('catches a service trusted to refuse a second write that writes over instead', async () => {
    await s3.control({ conditional: 'ignore' })
    const { kernel, act } = await bootStorage({
      settings: { ...bucketSettings(s3), 'storage.s3_no_overwrite': 'header' },
      env: bucketEnv,
    })
    const done = outcome(kernel, await act('test-connection'))
    expect(done.message).toContain(
      'Refuse to write over it: The storage wrote over an existing file.',
    )
  })

  it('says what’s missing before it tries anything, and wrong keys in the service’s word', async () => {
    const unset = await bootStorage({ settings: bucketSettings(s3), env: privateEnv })
    expect(outcome(unset.kernel, await unset.act('test-connection')).message).toContain(
      'Finish the settings: Set STORAGE_S3_ACCESS_KEY_ID',
    )
    const wrong = await bootStorage({
      settings: bucketSettings(s3),
      env: { ...bucketEnv, STORAGE_S3_SECRET_ACCESS_KEY: 'not-the-secret' },
    })
    const done = outcome(wrong.kernel, await wrong.act('test-connection'))
    expect(done.message).toContain('The storage refused to look a file up (403)')
    expect(done.message).not.toContain('not-the-secret')
  })

  it('is for those who manage storage only', async () => {
    const { harness, kernel } = await bootStorage({ settings: bucketSettings(s3), env: bucketEnv })
    const editor = await harness.signIn('editor')
    const refused = await harness.request('POST', kernel.actionUrl('storage', 'test-connection'), {
      form: {},
      cookie: editor.cookie,
    })
    expect(refused.status).toBe(403)
    expect(await s3.objects()).toEqual([])
  })
})

describe('copying the disk’s uploads across', () => {
  it('copies every file once, says what’s missing, and can be run again', async () => {
    const { kernel, act, uploads } = await bootStorage({
      settings: bucketSettings(s3),
      env: bucketEnv,
    })
    const image = await kernel.media.upload({ name: 'Beach.jpg', data: await photo() })
    const note = await kernel.media.upload({ name: 'notes.txt', data: bytes('packing list') })
    const lost = await kernel.media.upload({ name: 'lost.txt', data: bytes('gone from the disk') })
    rmSync(join(uploads, lost.file))
    const files = [image.file, ...Object.values(image.sizes).map((size) => size.file), note.file]
    const expected = [...new Set(files)].map((file) => `media/${file}`).sort()

    const started = outcome(kernel, await act('start-copy'))
    expect(started).toMatchObject({
      path: '/admin/storage/copy',
      message: 'Copying has begun, in the background.',
    })
    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(await keys()).toEqual(expected)
    const run = async () =>
      (await kernel.db.execute(
        'SELECT * FROM storage_copy_runs ORDER BY started_at DESC',
      )) as never as {
        rows: Record<string, unknown>[]
      }
    expect((await run()).rows[0]).toMatchObject({
      status: 'done',
      total: 3,
      position: 3,
      copied: expected.length,
      skipped: 0,
      missing: 1,
      failed: 0,
      missing_keys: [lost.file],
    })

    // Again: everything is there already, so nothing is sent.
    await act('start-copy')
    await kernel.jobs.runDue()
    expect((await run()).rows[0]).toMatchObject({
      status: 'done',
      copied: 0,
      skipped: expected.length,
      missing: 1,
    })
    expect(await keys()).toEqual(expected)
  })

  it('won’t start without a storage that’s ready, and stops when cancelled', async () => {
    const unset = await bootStorage({ settings: bucketSettings(s3), env: privateEnv })
    const refused = outcome(unset.kernel, await unset.act('start-copy'))
    expect(refused.kind).toBe('error')
    expect(refused.message).toContain('The copy couldn’t start: Set STORAGE_S3_ACCESS_KEY_ID')

    const { kernel, act } = await bootStorage({ settings: bucketSettings(s3), env: bucketEnv })
    await kernel.media.upload({ name: 'notes.txt', data: bytes('never copied') })
    await act('start-copy')
    // Pressed twice: still one run.
    await act('start-copy')
    const runs = (await kernel.db.execute('SELECT status FROM storage_copy_runs')) as never as {
      rows: unknown[]
    }
    expect(runs.rows).toEqual([{ status: 'running' }])
    expect(outcome(kernel, await act('cancel-copy')).message).toBe('The copy was cancelled.')
    await kernel.jobs.runDue()
    expect(await s3.objects()).toEqual([])
  })
})
