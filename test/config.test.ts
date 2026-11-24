import { describe, expect, it } from 'vitest'
import {
  cacheControlFor,
  cleanPrefix,
  cleanUrl,
  dispositionFor,
  hostKind,
  isSafeKey,
  s3Config,
  type S3Settings,
} from '../src/config'

const settings = (changes: Partial<S3Settings> = {}): S3Settings => ({
  service: 'aws',
  bucket: 'media',
  region: 'eu-west-1',
  account: '',
  endpoint: '',
  pathStyle: true,
  noOverwrite: 'check',
  publicUrl: '',
  prefix: '',
  accessKeyId: 'AKID',
  secretAccessKey: 'secret',
  cacheControl: 'public, max-age=86400',
  allowPrivate: false,
  ...changes,
})

describe('a bucket’s address', () => {
  it('is the bucket’s own host on Amazon, unless its name has a dot', () => {
    expect(s3Config(settings())).toMatchObject({
      base: 'https://media.s3.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      noOverwrite: 'header',
    })
    expect(s3Config(settings({ bucket: 'media.example.com' }))).toMatchObject({
      base: 'https://s3.eu-west-1.amazonaws.com/media.example.com',
    })
  })

  it('is the account’s on Cloudflare R2, whose region is always "auto"', () => {
    expect(
      s3Config(settings({ service: 'r2', account: 'ABCdef0123456789', region: '' })),
    ).toMatchObject({
      base: 'https://abcdef0123456789.r2.cloudflarestorage.com/media',
      region: 'auto',
      noOverwrite: 'header',
    })
  })

  it('is under the project’s storage path on Supabase, which is looked at first', () => {
    expect(
      s3Config(
        settings({ service: 'supabase', account: 'abcdefghijklmnop', region: 'eu-central-1' }),
      ),
    ).toMatchObject({
      base: 'https://abcdefghijklmnop.storage.supabase.co/storage/v1/s3/media',
      region: 'eu-central-1',
      noOverwrite: 'check',
    })
  })

  it('is as typed for a server of one’s own, either way round', () => {
    const custom = { service: 'custom' as const, region: 'us-east-1', allowPrivate: true }
    expect(
      s3Config(
        settings({ ...custom, endpoint: 'http://192.168.1.20:9000/', noOverwrite: 'header' }),
      ),
    ).toMatchObject({ base: 'http://192.168.1.20:9000/media', noOverwrite: 'header' })
    expect(
      s3Config(settings({ ...custom, endpoint: 'https://s3.example.com', pathStyle: false })),
    ).toMatchObject({ base: 'https://media.s3.example.com', noOverwrite: 'check' })
  })

  it('carries the folder and the public address, tidied', () => {
    expect(
      s3Config(settings({ prefix: '/site/files', publicUrl: 'https://media.example.com/' })),
    ).toMatchObject({ prefix: 'site/files/', publicUrl: 'https://media.example.com' })
  })
})

describe('what’s missing or wrong, in a sentence', () => {
  it.each([
    [{ bucket: '' }, 'Enter the bucket’s name.'],
    [{ bucket: 'Has Spaces' }, 'Enter the bucket’s name.'],
    [{ region: '' }, 'Enter the bucket’s region, such as eu-west-1.'],
    [{ service: 'r2' as const }, 'Enter the Cloudflare account ID.'],
    [{ service: 'supabase' as const }, 'Enter the Supabase project’s reference.'],
    [
      { service: 'custom' as const, endpoint: 'ftp://files.example.com' },
      'Enter the service’s address, such as https://s3.example.com.',
    ],
    [
      { service: 'custom' as const, endpoint: 'https://user:pass@s3.example.com' },
      'Enter the service’s address, such as https://s3.example.com.',
    ],
    [
      { accessKeyId: undefined },
      'Set STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY in the site’s environment.',
    ],
    [{ prefix: '../other' }, 'The folder may hold letters, digits, dots, dashes and slashes.'],
    [
      { publicUrl: 'media.example.com' },
      'The public address must be a web address, such as https://media.example.com.',
    ],
  ])('%j', (changes, problem) => {
    expect(s3Config(settings(changes))).toBe(problem)
  })
})

describe('addresses a storage is never at', () => {
  it.each([
    ['169.254.169.254', 'metadata'],
    ['169.254.0.1', 'metadata'],
    ['metadata.google.internal', 'metadata'],
    ['[fd00:ec2::254]', 'metadata'],
    ['[fe80::1]', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['127.0.0.1', 'private'],
    ['localhost', 'private'],
    ['storage.localhost', 'private'],
    ['10.0.0.5', 'private'],
    ['172.16.4.1', 'private'],
    ['192.168.1.20', 'private'],
    ['100.64.0.1', 'private'],
    ['0.0.0.0', 'private'],
    ['[::1]', 'private'],
    ['[::ffff:127.0.0.1]', 'private'],
    ['[::ffff:7f00:1]', 'private'],
    ['[fd12:3456::1]', 'private'],
    ['s3.example.com', 'public'],
    ['172.32.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['[2001:db8::1]', 'public'],
  ])('%s is %s', (host, kind) => {
    expect(hostKind(host)).toBe(kind)
  })

  it('sees through the other ways an address can be written', () => {
    // As URL parsing gives them back: a number, hex, and a short form are all 127.0.0.1.
    for (const written of [
      'http://2130706433',
      'http://0x7f.0.0.1',
      'http://127.1',
      'http://LOCALHOST.',
    ]) {
      expect(hostKind(new URL(written).hostname)).toBe('private')
    }
    expect(hostKind(new URL('http://[::ffff:169.254.169.254]').hostname)).toBe('metadata')
  })

  const custom = (endpoint: string, allowPrivate = false) =>
    s3Config(settings({ service: 'custom', region: 'us-east-1', endpoint, allowPrivate }))

  it('refuses a cloud’s metadata address whatever the server allows', () => {
    for (const endpoint of ['http://169.254.169.254', 'http://metadata.google.internal']) {
      expect(custom(endpoint, true)).toBe('That address isn’t a storage service’s.')
      expect(custom(endpoint, false)).toBe('That address isn’t a storage service’s.')
    }
  })

  it('takes an address on the server’s own network only when the server says so', () => {
    for (const endpoint of ['http://127.0.0.1:8500', 'http://localhost:9000', 'http://10.0.0.5']) {
      expect(custom(endpoint)).toContain('STORAGE_ALLOW_PRIVATE_ENDPOINT=1')
      expect(custom(endpoint, true)).toMatchObject({ noOverwrite: 'check' })
    }
  })

  it('holds the public address to the same', () => {
    expect(s3Config(settings({ publicUrl: 'http://169.254.169.254/latest' }))).toBe(
      'The public address can’t be used. That address isn’t a storage service’s.',
    )
    expect(s3Config(settings({ publicUrl: 'http://192.168.1.9' }))).toContain(
      'The public address can’t be used.',
    )
  })
})

describe('the small rules', () => {
  it('cleans a folder, and refuses one that climbs out', () => {
    expect(cleanPrefix('')).toBe('')
    expect(cleanPrefix(' a/b/ ')).toBe('a/b/')
    expect(cleanPrefix('a/../b')).toBeNull()
    expect(cleanPrefix('a b')).toBeNull()
    expect(cleanPrefix('.hidden')).toBeNull()
  })

  it('takes a web address without a query, a sign-in or a fragment', () => {
    expect(cleanUrl('https://cdn.example.com/media/', { http: false })).toBe(
      'https://cdn.example.com/media',
    )
    expect(cleanUrl('http://cdn.example.com', { http: false })).toBeNull()
    expect(cleanUrl('https://cdn.example.com/?token=1', { http: true })).toBeNull()
    expect(cleanUrl('javascript:alert(1)', { http: true })).toBeNull()
  })

  it('shows what browsers can show, and downloads the rest, as the CMS does', () => {
    expect(dispositionFor('image/jpeg')).toBe('inline')
    expect(dispositionFor('application/pdf')).toBe('inline')
    expect(dispositionFor('video/mp4')).toBe('inline')
    expect(dispositionFor('text/plain')).toBe('inline')
    expect(dispositionFor('application/zip')).toBe('attachment')
    expect(dispositionFor('application/octet-stream')).toBe('attachment')
    // A bucket's address has no sandbox: what could carry a script always downloads.
    for (const type of ['image/svg+xml', 'text/html', 'text/xml', 'application/xhtml+xml']) {
      expect(dispositionFor(type)).toBe('attachment')
    }
  })

  it('knows a key the CMS could have made from one it couldn’t', () => {
    expect(isSafeKey('2026/11/photo-300x200.jpg')).toBe(true)
    expect(isSafeKey('_uploads/3f0e4a9e-7d0c-4f5e-9a51-0f6b8f6f2c11')).toBe(true)
    for (const key of [
      '',
      '../a',
      'a/../b',
      'a//b',
      '/a',
      'a/.env',
      'a b',
      'a%2fb',
      'a?b',
      'a#b',
    ]) {
      expect(isSafeKey(key)).toBe(false)
    }
  })

  it('caches for a day unless told otherwise', () => {
    expect(cacheControlFor(undefined)).toBe('public, max-age=86400')
    expect(cacheControlFor('year')).toBe('public, max-age=31536000')
    expect(cacheControlFor('nonsense')).toBe('public, max-age=86400')
  })
})
