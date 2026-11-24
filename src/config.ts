import type { Credentials } from './sigv4'

/** The S3-compatible services with a preset, and `custom` for any other, a server of one's own included. */
export type S3Service = 'aws' | 'r2' | 'supabase' | 'custom'

/**
 * How a file's key is kept from being written twice. `header`: the service refuses the second
 * write itself (`If-None-Match: *`). `check`: it's looked for first, under a lock, for services
 * that don't.
 */
export type NoOverwrite = 'header' | 'check'

/** What Settings › Storage and the environment say about an S3-compatible bucket, as typed. */
export interface S3Settings {
  service: S3Service
  bucket: string
  region: string
  /** Cloudflare's account ID, or Supabase's project reference. */
  account: string
  /** A custom service's address, such as `https://s3.example.com`. */
  endpoint: string
  pathStyle: boolean
  noOverwrite: NoOverwrite
  /** Where the bucket's files are public, such as a CDN's address; empty to serve through the site. */
  publicUrl: string
  /** A folder inside the bucket, for a bucket shared with something else. */
  prefix: string
  accessKeyId: string | undefined
  secretAccessKey: string | undefined
  /** `Cache-Control` for stored files. */
  cacheControl: string
  /**
   * Whether addresses on the server's own network are taken: `STORAGE_ALLOW_PRIVATE_ENDPOINT`,
   * which only whoever runs the server can set.
   */
  allowPrivate: boolean
}

/** A bucket ready to be talked to: every address worked out, every input checked. */
export interface S3Config {
  /** The address objects live under, without a trailing slash: the bucket's own. */
  base: string
  region: string
  credentials: Credentials
  noOverwrite: NoOverwrite
  prefix: string
  cacheControl: string
  /** Where files are public, without a trailing slash, or `null`. */
  publicUrl: string | null
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/
const ACCOUNT = /^[a-z0-9]{6,64}$/i
const PREFIX_SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/i

/** `folder/sub/` from what was typed, or `null` when it couldn't be a folder's path. */
export function cleanPrefix(value: string): string | null {
  const segments = value.trim().split('/').filter(Boolean)
  if (segments.some((segment) => !PREFIX_SEGMENT.test(segment) || segment.includes('..'))) {
    return null
  }
  return segments.length > 0 ? `${segments.join('/')}/` : ''
}

/** Where a cloud server answers questions about itself, keys included: never a storage service. */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  '[fd00:ec2::254]',
])

/** The four numbers of an IPv4 address, also when written inside an IPv6 one; else `null`. */
function ipv4Of(hostname: string): number[] | null {
  const dotted = /^(?:\[::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\]?$/i.exec(hostname)
  if (dotted) return dotted.slice(1).map(Number)
  // `[::ffff:7f00:1]`: the same address, as URL parsing writes it.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(hostname)
  if (!mapped) return null
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

/**
 * What kind of place a host name points at, from the name alone: `metadata` for a cloud's own
 * answering service and link-local addresses, `private` for this machine and private networks,
 * `public` otherwise. A name that only resolves to a private address isn't caught here.
 */
export function hostKind(hostname: string): 'public' | 'private' | 'metadata' {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (METADATA_HOSTS.has(host)) return 'metadata'
  const ip = ipv4Of(host)
  if (ip) {
    const [a, b] = ip as [number, number, number, number]
    if (a === 169 && b === 254) return 'metadata'
    const isPrivate =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    return isPrivate ? 'private' : 'public'
  }
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    if (/^fe[89ab]/.test(address)) return 'metadata'
    return address === '::1' || address === '::' || /^f[cd]/.test(address) ? 'private' : 'public'
  }
  return host === 'localhost' || host.endsWith('.localhost') ? 'private' : 'public'
}

/** Why an address can't be used, in a sentence, or `null`. */
export function hostProblem(url: string, allowPrivate: boolean): string | null {
  const kind = hostKind(new URL(url).hostname)
  if (kind === 'metadata') return 'That address isn’t a storage service’s.'
  if (kind === 'private' && !allowPrivate) {
    return 'That address is on the server’s own network. To use a storage there, set STORAGE_ALLOW_PRIVATE_ENDPOINT=1 in the site’s environment.'
  }
  return null
}

/** An address on the web without a query, sign-in or fragment, and no trailing slash; or `null`. */
export function cleanUrl(value: string, options: { http: boolean }): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const allowed = url.protocol === 'https:' || (options.http && url.protocol === 'http:')
  if (!allowed || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function endpointOf(settings: S3Settings): { endpoint: string; pathStyle: boolean } | string {
  switch (settings.service) {
    case 'aws':
      if (!REGION.test(settings.region)) return 'Enter the bucket’s region, such as eu-west-1.'
      // A dot in a bucket's name breaks the certificate of its own host name.
      return {
        endpoint: `https://s3.${settings.region}.amazonaws.com`,
        pathStyle: settings.bucket.includes('.'),
      }
    case 'r2':
      if (!ACCOUNT.test(settings.account)) return 'Enter the Cloudflare account ID.'
      return {
        endpoint: `https://${settings.account.toLowerCase()}.r2.cloudflarestorage.com`,
        pathStyle: true,
      }
    case 'supabase':
      if (!ACCOUNT.test(settings.account)) return 'Enter the Supabase project’s reference.'
      if (!REGION.test(settings.region)) return 'Enter the project’s region, such as eu-central-1.'
      return {
        endpoint: `https://${settings.account.toLowerCase()}.storage.supabase.co/storage/v1/s3`,
        pathStyle: true,
      }
    case 'custom': {
      // A server of one's own may be on a private network without a certificate.
      const endpoint = cleanUrl(settings.endpoint, { http: true })
      if (!endpoint) return 'Enter the service’s address, such as https://s3.example.com.'
      const refused = hostProblem(endpoint, settings.allowPrivate)
      if (refused) return refused
      if (!REGION.test(settings.region)) return 'Enter a region; many servers take us-east-1.'
      return { endpoint, pathStyle: settings.pathStyle }
    }
  }
}

/** Services whose second write to a key is known to be refused by the header alone. */
const HEADER_SERVICES: ReadonlySet<S3Service> = new Set(['aws', 'r2'])

/** The bucket's configuration, or what's missing or wrong, in a sentence. */
export function s3Config(settings: S3Settings): S3Config | string {
  if (!BUCKET.test(settings.bucket)) return 'Enter the bucket’s name.'
  const where = endpointOf(settings)
  if (typeof where === 'string') return where
  if (!settings.accessKeyId || !settings.secretAccessKey) {
    return 'Set STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY in the site’s environment.'
  }
  const prefix = cleanPrefix(settings.prefix)
  if (prefix === null) return 'The folder may hold letters, digits, dots, dashes and slashes.'
  const publicUrl = settings.publicUrl.trim() ? cleanUrl(settings.publicUrl, { http: true }) : null
  if (settings.publicUrl.trim() && !publicUrl) {
    return 'The public address must be a web address, such as https://media.example.com.'
  }
  const refused = publicUrl ? hostProblem(publicUrl, settings.allowPrivate) : null
  if (refused) return `The public address can’t be used. ${refused}`
  const endpoint = new URL(where.endpoint)
  const base = where.pathStyle
    ? `${where.endpoint}/${settings.bucket}`
    : `${endpoint.protocol}//${settings.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, '')}`
  return {
    base,
    region: settings.service === 'r2' ? 'auto' : settings.region,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    noOverwrite:
      settings.service === 'custom'
        ? settings.noOverwrite
        : HEADER_SERVICES.has(settings.service)
          ? 'header'
          : 'check',
    prefix,
    cacheControl: settings.cacheControl,
    publicUrl,
  }
}

/**
 * What a browser may show in the page; anything else downloads. Narrower than the CMS's own rule
 * for files it serves itself: a bucket's address can't add the sandbox the site does, so nothing
 * that could carry a script (SVG, HTML, XML) is ever shown from there.
 */
const INLINE =
  /^image\/(jpeg|png|gif|webp|avif)$|^(audio|video)\/|^application\/pdf$|^text\/(plain|csv)$/

/** A key the CMS could have made: the rule its own disk storage holds every key to. */
const KEY_SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/i
const MAX_KEY = 512

/** Whether `key` is safe to put in an address: no `..`, no query, no encoding, nothing hidden. */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY) return false
  return key.split('/').every((segment) => KEY_SEGMENT.test(segment) && !segment.includes('..'))
}

/** `Content-Disposition` for a stored file, from its type. */
export function dispositionFor(contentType: string): 'inline' | 'attachment' {
  return INLINE.test(contentType) ? 'inline' : 'attachment'
}

/** The choices for how long browsers and CDNs may keep a file, as `Cache-Control`. */
export const CACHE_CONTROL = {
  day: 'public, max-age=86400',
  month: 'public, max-age=2592000',
  year: 'public, max-age=31536000',
} as const

export type CacheChoice = keyof typeof CACHE_CONTROL

export function cacheControlFor(choice: string | undefined): string {
  return CACHE_CONTROL[(choice ?? 'day') as CacheChoice] ?? CACHE_CONTROL.day
}
