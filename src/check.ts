import { randomUUID } from 'node:crypto'
import type { StorageConnection, StorageDriver } from './drivers'
import { readCapped, request, StorageError, type Fetch } from './http'

/** One thing the connection test tried, and how it went. */
export interface CheckResult {
  /** What was tried, as a sentence's start: "Store a file". */
  step: string
  ok: boolean
  /** What happened when it didn't pass, or what to know when it did. */
  detail?: string
}

/** Where the test's own files go: a folder nothing else uses. */
const PROBE_FOLDER = '_check'
const PROBE = new TextEncoder().encode('OTW CMS storage connection test')

/** What went wrong, in words an administrator can use: never a stack or an address. */
function why(error: unknown): string {
  if (error instanceof StorageError) return error.message
  return error instanceof Error ? error.message : 'It failed; see the server’s log.'
}

/** A probe's bytes back as text: no more than the probe is long, whatever the storage sends. */
async function textOf(body: ReadableStream<Uint8Array>): Promise<string> {
  return readCapped(new Response(body), PROBE.byteLength + 1)
}

/**
 * Tries everything the media library will ask of a storage, on files of its own, and says what
 * works: storing, never writing over, reading in part, looking up, deleting, and whether a
 * browser on `siteOrigin` can upload to it. It reads no file of the site's and leaves none.
 */
export async function checkConnection(
  driver: StorageDriver,
  options: { siteOrigin: string | null; fetch: Fetch },
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const tried = async (step: string, run: () => Promise<string | void>): Promise<boolean> => {
    try {
      const detail = await run()
      results.push({ step, ok: true, ...(detail ? { detail } : {}) })
      return true
    } catch (error) {
      results.push({ step, ok: false, detail: why(error) })
      return false
    }
  }
  const fail = (message: string): never => {
    throw new Error(message)
  }

  let storage!: StorageConnection
  if (!(await tried('Connect', async () => void (storage = await driver.connect())))) return results

  const key = `${PROBE_FOLDER}/${randomUUID()}.txt`
  const stored = await tried('Store a file', async () => {
    if (!(await storage.create(key, PROBE, 'text/plain')))
      fail('The storage said the name was taken.')
  })
  if (stored) {
    await tried('Refuse to write over it', async () => {
      const again = await storage.create(
        key,
        new TextEncoder().encode('written over'),
        'text/plain',
      )
      const file = await storage.read(key)
      const kept = file ? await textOf(file.body) : ''
      if (again || kept !== new TextDecoder().decode(PROBE)) {
        fail(
          'The storage wrote over an existing file. Set “Never write over a file” to “Look first”.',
        )
      }
    })
    await tried('Look a file up', async () => {
      const info = await storage.stat(key)
      if (info?.size !== PROBE.byteLength) fail('Its size came back wrong.')
    })
    await tried('Read part of a file', async () => {
      const part = await storage.read(key, { start: 4, end: 6 })
      if (!part || (await textOf(part.body)) !== 'CMS' || part.size !== PROBE.byteLength) {
        fail('A range of the file came back wrong: videos wouldn’t play from it.')
      }
    })
  }
  await tried('Tell a missing file from a forbidden one', async () => {
    try {
      if ((await storage.stat(`${PROBE_FOLDER}/${randomUUID()}.txt`)) !== null) {
        fail('A file that doesn’t exist was found.')
      }
    } catch (error) {
      // S3 answers 403 for a missing file when the keys may not list the bucket.
      if (error instanceof StorageError && error.code === 'auth') {
        fail(
          'A file that isn’t there looks forbidden. Let the keys list the bucket (s3:ListBucket), or missing files show as errors.',
        )
      }
      throw error
    }
  })

  if (driver.directUploads && storage.uploadTarget) {
    const waiting = `_uploads/${randomUUID()}`
    const signed = await tried('Take an upload at a signed address', async () => {
      const target = await storage.uploadTarget!(waiting, {
        size: PROBE.byteLength,
        expiresAt: new Date(Date.now() + 60_000),
      })
      const sent = await request(options.fetch, target.url, {
        method: target.method,
        headers: { ...target.headers, 'content-length': String(PROBE.byteLength) },
        body: PROBE,
      })
      await sent.body?.cancel()
      if (!sent.ok) fail(`The storage answered ${sent.status} to a signed upload.`)
      if (!options.siteOrigin) {
        return 'Set the site’s address in Settings › General to check that browsers may send files too.'
      }
      // What a browser asks before it sends a file from the site's pages.
      const preflight = await request(options.fetch, target.url, {
        method: 'OPTIONS',
        headers: {
          origin: options.siteOrigin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      })
      await preflight.body?.cancel()
      const allowed = preflight.headers.get('access-control-allow-origin')
      if (!preflight.ok || (allowed !== '*' && allowed !== options.siteOrigin)) {
        fail(
          `Its CORS rules don’t let ${options.siteOrigin} send files: allow that origin, the PUT method and the content-type header. Until then, files over the limit of a request can’t be uploaded.`,
        )
      }
      return `Browsers on ${options.siteOrigin} can upload straight to it.`
    })
    if (signed || (await storage.stat(waiting).catch(() => null))) {
      await storage.delete(waiting).catch(() => {})
    }
  }

  const address = driver.publicUrl(key)
  if (stored && address) {
    await tried('Serve a file at the public address', async () => {
      const served = await request(options.fetch, address, { method: 'GET', headers: {} })
      const body = served.ok ? await readCapped(served, PROBE.byteLength + 1) : ''
      if (!served.ok) await served.body?.cancel()
      if (body !== new TextDecoder().decode(PROBE)) {
        fail(
          `The public address answered ${served.status} for a file just stored: it isn’t this bucket’s, or the bucket isn’t public.`,
        )
      }
    })
  }
  if (stored) {
    await tried('Delete a file', async () => {
      await storage.delete(key)
      if ((await storage.stat(key).catch(() => null)) !== null) fail('The file is still there.')
    })
  }
  return results
}
