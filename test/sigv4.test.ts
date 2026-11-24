import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { presignUrl, sha256Hex, signHeaders, UNSIGNED_PAYLOAD } from '../src/sigv4'

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}
const now = new Date('2026-11-24T10:20:30.123Z')

interface Reference {
  mode: 'sign' | 'presign'
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  region: string
  expiresIn?: number
}

/**
 * The same request signed by Amazon's own signer (@smithy/signature-v4), as the oracle. It runs
 * in a Node process of its own: Vitest starts its workers with the `module` export condition,
 * under which that package resolves to a build Node can't load.
 */
function official(input: Reference): {
  headers: Record<string, string>
  query: Record<string, string>
} {
  const script = `
    const { Sha256 } = require('@aws-crypto/sha256-js')
    const { SignatureV4 } = require('@smithy/signature-v4')
    const input = JSON.parse(process.argv[1])
    const url = new URL(input.url)
    const signer = new SignatureV4({
      credentials: input.credentials,
      region: input.region,
      service: 's3',
      sha256: Sha256,
      applyChecksum: true,
      // S3's own rule: its paths are encoded once, not twice.
      uriEscapePath: false,
    })
    const request = {
      method: input.method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: decodeURIComponent(url.pathname) === url.pathname ? url.pathname : url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: {
        host: url.host,
        ...input.headers,
        // What Amazon's S3 presigner sets: the body isn't known when an address is signed.
        ...(input.mode === 'presign' ? { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' } : {}),
      },
      body: input.body,
    }
    const signingDate = new Date(input.now)
    const done = input.mode === 'presign'
      ? signer.presign(request, {
          signingDate,
          expiresIn: input.expiresIn,
          // Signed as headers the browser sends, not moved into the address.
          unhoistableHeaders: new Set(Object.keys(input.headers)),
          signableHeaders: new Set(Object.keys(input.headers)),
        })
      : signer.sign(request, { signingDate })
    done.then((signed) => console.log(JSON.stringify({ headers: signed.headers, query: signed.query ?? {} })))
  `
  const output = execFileSync(
    process.execPath,
    ['-e', script, JSON.stringify({ ...input, credentials, now: now.toISOString() })],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  )
  return JSON.parse(output) as ReturnType<typeof official>
}

describe('signHeaders', () => {
  it('signs a file being stored as Amazon’s own signer does', async () => {
    const body = 'the bytes of a photo'
    const url = 'https://media.s3.eu-west-1.amazonaws.com/2026/11/Beach%20photo-1.jpg'
    const headers = {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400',
      'content-disposition': 'inline',
      'if-none-match': '*',
    }
    const ours = await signHeaders({
      method: 'PUT',
      url: new URL(url),
      headers,
      payloadHash: await sha256Hex(body),
      credentials,
      region: 'eu-west-1',
      now,
    })
    const theirs = official({
      mode: 'sign',
      method: 'PUT',
      url,
      headers,
      body,
      region: 'eu-west-1',
    })
    expect(ours.authorization).toBe(theirs.headers.authorization)
    expect(ours['x-amz-date']).toBe('20261124T102030Z')
    expect(ours['x-amz-content-sha256']).toBe(theirs.headers['x-amz-content-sha256'])
  })

  it('signs a ranged read under a path prefix and a port, as Supabase and a server of one’s own have', async () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(await sha256Hex('')).toBe(empty)
    for (const url of [
      'https://abcdefghij.storage.supabase.co/storage/v1/s3/media/site/2026/11/a.jpg',
      'http://127.0.0.1:9000/media/_uploads/3f0e4a9e-7d0c-4f5e-9a51-0f6b8f6f2c11',
    ]) {
      const headers = { range: 'bytes=0-99' }
      const ours = await signHeaders({
        method: 'GET',
        url: new URL(url),
        headers,
        payloadHash: empty,
        credentials,
        region: 'eu-central-1',
        now,
      })
      const theirs = official({ mode: 'sign', method: 'GET', url, headers, region: 'eu-central-1' })
      expect(ours.authorization).toBe(theirs.headers.authorization)
    }
  })
})

describe('presignUrl', () => {
  it('signs an address for a browser’s upload as Amazon’s own signer does', async () => {
    const url =
      'https://account.r2.cloudflarestorage.com/media/_uploads/3f0e4a9e-7d0c-4f5e-9a51-0f6b8f6f2c11'
    const headers = { 'content-type': 'application/octet-stream', 'content-length': '5242880' }
    const ours = new URL(
      await presignUrl({
        method: 'PUT',
        url: new URL(url),
        headers,
        credentials,
        region: 'auto',
        expiresInSeconds: 900,
        now,
      }),
    )
    const theirs = official({
      mode: 'presign',
      method: 'PUT',
      url,
      headers,
      region: 'auto',
      expiresIn: 900,
    })
    expect(Object.fromEntries(ours.searchParams)).toEqual(theirs.query)
    expect(ours.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(ours.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(ours.origin + ours.pathname).toBe(url)
    expect(UNSIGNED_PAYLOAD).toBe('UNSIGNED-PAYLOAD')
  })

  it('keeps an address’s life between a second and a week', async () => {
    const sign = async (expiresInSeconds: number) =>
      new URL(
        await presignUrl({
          method: 'PUT',
          url: new URL('https://s3.example.com/media/a'),
          credentials,
          region: 'us-east-1',
          expiresInSeconds,
          now,
        }),
      ).searchParams.get('X-Amz-Expires')
    expect(await sign(-5)).toBe('1')
    expect(await sign(0.2)).toBe('1')
    expect(await sign(10 * 24 * 60 * 60)).toBe('604800')
  })
})
