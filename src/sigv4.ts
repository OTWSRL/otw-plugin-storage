/**
 * AWS Signature Version 4, as S3 and the services that speak its protocol check it: signed
 * headers for the site's own requests, and signed addresses a browser can send a file to. On
 * WebCrypto, with nothing from an SDK; `test/sigv4.test.ts` holds it to Amazon's own signer.
 */

export interface Credentials {
  accessKeyId: string
  secretAccessKey: string
}

/** The payload hash of an address signed ahead of its body: the bytes aren't known yet. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
/** The longest a signed address may last: a week, S3's own limit. */
export const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60

/**
 * Sent, but never signed, as Amazon's own SDKs leave it: a proxy on the way may rewrite it, and
 * a signed header that changed would fail the whole request.
 */
const UNSIGNED_HEADERS: ReadonlySet<string> = new Set(['cache-control'])

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of some bytes, as hex: what a request says its body is. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', imported, encoder.encode(message))
}

/** RFC 3986's percent-encoding, which S3 signs with: stricter than `encodeURIComponent`. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** The path as S3 canonicalises it: each segment encoded once, slashes kept. */
function canonicalPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/')
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

/** `20261124T101500Z` and its day, for a moment. */
function stamps(now: Date) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  return { amzDate, day: amzDate.slice(0, 8) }
}

interface Signable {
  method: string
  url: URL
  /** The headers to sign, besides `host`. Names in any case. */
  headers: Record<string, string>
  payloadHash: string
  credentials: Credentials
  region: string
  now: Date
}

async function signature(input: Signable, query: URLSearchParams) {
  const { amzDate, day } = stamps(input.now)
  const headers = Object.entries({ ...input.headers, host: input.url.host })
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .filter(([name]) => !UNSIGNED_HEADERS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const signedHeaders = headers.map(([name]) => name).join(';')
  const request = [
    input.method.toUpperCase(),
    canonicalPath(input.url.pathname),
    canonicalQuery(query),
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const scope = `${day}/${input.region}/${SERVICE}/aws4_request`
  const toSign = [ALGORITHM, amzDate, scope, await sha256Hex(request)].join('\n')
  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), day)
  for (const part of [input.region, SERVICE, 'aws4_request']) key = await hmac(key, part)
  return { signature: hex(await hmac(key, toSign)), signedHeaders, scope, amzDate }
}

/**
 * The headers that sign a request the site sends itself: `authorization`, `x-amz-date` and
 * `x-amz-content-sha256`, to add to those given. `host` is signed too; `fetch` sends it.
 */
export async function signHeaders(input: {
  method: string
  url: URL
  headers?: Record<string, string>
  /** The body's SHA-256, as hex: of the empty string for a request without one. */
  payloadHash: string
  credentials: Credentials
  region: string
  now?: Date
}): Promise<Record<string, string>> {
  const now = input.now ?? new Date()
  const headers = {
    ...input.headers,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': stamps(now).amzDate,
  }
  const signed = await signature({ ...input, headers, now }, input.url.searchParams)
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${signed.scope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`,
  }
}

/**
 * An address that carries its own signature, for a browser to send one request to: this method,
 * this path, these headers exactly, for `expiresInSeconds` from now.
 */
export async function presignUrl(input: {
  method: string
  url: URL
  /** Headers the browser must send as given: they're part of what's signed. */
  headers?: Record<string, string>
  credentials: Credentials
  region: string
  expiresInSeconds: number
  now?: Date
}): Promise<string> {
  const now = input.now ?? new Date()
  const expires = Math.min(MAX_EXPIRES_SECONDS, Math.max(1, Math.ceil(input.expiresInSeconds)))
  const { amzDate, day } = stamps(now)
  const headers = input.headers ?? {}
  const signedNames = [...Object.keys(headers).map((name) => name.toLowerCase()), 'host']
    .sort()
    .join(';')
  const url = new URL(input.url)
  url.searchParams.set('X-Amz-Algorithm', ALGORITHM)
  // Said in the address too, as Amazon's SDKs say it: the body isn't part of what's signed.
  url.searchParams.set('X-Amz-Content-Sha256', UNSIGNED_PAYLOAD)
  url.searchParams.set(
    'X-Amz-Credential',
    `${input.credentials.accessKeyId}/${day}/${input.region}/${SERVICE}/aws4_request`,
  )
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(expires))
  url.searchParams.set('X-Amz-SignedHeaders', signedNames)
  const signed = await signature(
    { ...input, url, headers, payloadHash: UNSIGNED_PAYLOAD, now },
    url.searchParams,
  )
  // Built by hand: URLSearchParams would encode a space as "+", which S3 reads as a plus.
  return `${url.origin}${canonicalPath(url.pathname)}?${canonicalQuery(url.searchParams)}&X-Amz-Signature=${signed.signature}`
}
