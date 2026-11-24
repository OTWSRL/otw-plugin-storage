import { describe, expect, it } from 'vitest'
import {
  cacheControlFor,
  cleanPrefix,
  cleanUrl,
  dispositionFor,
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
    const custom = { service: 'custom' as const, region: 'us-east-1' }
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
    expect(dispositionFor('application/zip')).toBe('attachment')
    expect(dispositionFor('application/octet-stream')).toBe('attachment')
  })

  it('caches for a day unless told otherwise', () => {
    expect(cacheControlFor(undefined)).toBe('public, max-age=86400')
    expect(cacheControlFor('year')).toBe('public, max-age=31536000')
    expect(cacheControlFor('nonsense')).toBe('public, max-age=86400')
  })
})
