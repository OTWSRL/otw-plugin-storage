// Stands in for S3, or a service that speaks its protocol, in the tests: path-style buckets kept
// in memory, requests checked against their Signature Version 4 (worked out here from the
// specification, apart from the plugin's own signer), ranges, conditional writes and CORS.
//
// Run it:  FAKE_S3_PORT=3501 node fake-s3.mjs
// Steer it: POST /__control  { "conditional": "honour" | "reject" | "ignore", "cors": true | false }
// Look in:  GET /__objects   → [{ key, size, type, cache, disposition }]
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number(process.env.FAKE_S3_PORT ?? 3501)
const ACCESS_KEY = process.env.FAKE_S3_ACCESS_KEY ?? 'fake-access-key'
const SECRET_KEY = process.env.FAKE_S3_SECRET_KEY ?? 'fake-secret-key'
const REGION = process.env.FAKE_S3_REGION ?? 'us-east-1'
/** The one site whose pages may send files here, as a bucket's CORS rules name it. */
const ALLOWED_ORIGIN = process.env.FAKE_S3_ALLOWED_ORIGIN ?? ''

const objects = new Map()
const state = { conditional: 'honour', cors: true }

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

function xml(response, status, code, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/xml', ...headers })
  response.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`)
}

/** The signature a request should carry, from what it says it signed. */
function expectedSignature(
  request,
  url,
  { amzDate, signedHeaders, payloadHash, withoutSignature },
) {
  const query = [...url.searchParams]
    .filter(([name]) => !(withoutSignature && name === 'X-Amz-Signature'))
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
  const path = url.pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/')
  const names = signedHeaders.split(';')
  const canonical = [
    request.method,
    path,
    query,
    ...names.map((name) => `${name}:${String(request.headers[name] ?? '').trim()}`),
    '',
    signedHeaders,
    payloadHash,
  ].join('\n')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${REGION}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  let key = hmac(`AWS4${SECRET_KEY}`, day)
  for (const part of [REGION, 's3', 'aws4_request']) key = hmac(key, part)
  return { signature: hmac(key, toSign).toString('hex'), scope }
}

/** Whether the request is signed by the test's keys: by its headers, or in its address. */
function signatureProblem(request, url, body) {
  const authorization = request.headers.authorization
  if (authorization) {
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\S+), SignedHeaders=(\S+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      )
    if (!match) return 'AuthorizationHeaderMalformed'
    const [, accessKey, scope, signedHeaders, signature] = match
    if (accessKey !== ACCESS_KEY) return 'InvalidAccessKeyId'
    const payloadHash = request.headers['x-amz-content-sha256'] ?? ''
    if (payloadHash !== sha256(body)) return 'XAmzContentSHA256Mismatch'
    if (!signedHeaders.split(';').includes('host')) return 'AccessDenied'
    const expected = expectedSignature(request, url, {
      amzDate: String(request.headers['x-amz-date'] ?? ''),
      signedHeaders,
      payloadHash,
      withoutSignature: false,
    })
    return expected.signature === signature && expected.scope === scope
      ? null
      : 'SignatureDoesNotMatch'
  }
  const signature = url.searchParams.get('X-Amz-Signature')
  if (!signature) return 'AccessDenied'
  const amzDate = url.searchParams.get('X-Amz-Date') ?? ''
  const credential = url.searchParams.get('X-Amz-Credential') ?? ''
  if (!credential.startsWith(`${ACCESS_KEY}/`)) return 'InvalidAccessKeyId'
  const started = Date.parse(
    amzDate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'),
  )
  const lasts = Number(url.searchParams.get('X-Amz-Expires') ?? 0) * 1000
  if (!Number.isFinite(started) || Date.now() > started + lasts) return 'AccessDenied'
  const expected = expectedSignature(request, url, {
    amzDate,
    signedHeaders: url.searchParams.get('X-Amz-SignedHeaders') ?? '',
    payloadHash: 'UNSIGNED-PAYLOAD',
    withoutSignature: true,
  })
  return expected.signature === signature ? null : 'SignatureDoesNotMatch'
}

async function bodyOf(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const origin = request.headers.origin
  const cors =
    state.cors && origin && origin === ALLOWED_ORIGIN
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {}

  if (url.pathname === '/health') return response.writeHead(200).end('ok')
  if (url.pathname === '/__control' && request.method === 'POST') {
    Object.assign(state, JSON.parse((await bodyOf(request)).toString() || '{}'))
    return response.writeHead(204).end()
  }
  if (url.pathname === '/__objects') {
    if (request.method === 'DELETE') objects.clear()
    const list = [...objects].map(([key, object]) => ({
      key,
      size: object.data.byteLength,
      type: object.type,
      cache: object.cache,
      disposition: object.disposition,
    }))
    return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list))
  }

  // A browser asks before it sends a file from another site's page.
  if (request.method === 'OPTIONS') {
    if (!cors['access-control-allow-origin']) return xml(response, 403, 'AccessForbidden')
    return response
      .writeHead(200, {
        ...cors,
        'access-control-allow-methods': 'PUT',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '3600',
      })
      .end()
  }

  const body = await bodyOf(request)
  const problem = signatureProblem(request, url, body)
  if (problem) return xml(response, 403, problem, cors)
  // Path-style: /bucket/key. The key is everything after the bucket.
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const object = objects.get(key)

  if (request.method === 'PUT') {
    if (request.headers['if-none-match'] === '*') {
      if (state.conditional === 'reject') return xml(response, 501, 'NotImplemented', cors)
      if (state.conditional === 'honour' && object) {
        return xml(response, 412, 'PreconditionFailed', cors)
      }
    }
    objects.set(key, {
      data: body,
      type: request.headers['content-type'] ?? 'binary/octet-stream',
      cache: request.headers['cache-control'] ?? null,
      disposition: request.headers['content-disposition'] ?? null,
      at: new Date(),
    })
    return response.writeHead(200, { ...cors, etag: `"${sha256(body).slice(0, 32)}"` }).end()
  }
  if (request.method === 'DELETE') {
    objects.delete(key)
    return response.writeHead(204).end()
  }
  if (request.method === 'HEAD' || request.method === 'GET') {
    if (!object) return xml(response, 404, 'NoSuchKey')
    const size = object.data.byteLength
    const headers = {
      'content-type': object.type,
      'last-modified': object.at.toUTCString(),
      'accept-ranges': 'bytes',
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (range && request.method === 'GET') {
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), size - 1)
      if (start >= size) return xml(response, 416, 'InvalidRange')
      const part = object.data.subarray(start, end + 1)
      response.writeHead(206, {
        ...headers,
        'content-length': part.byteLength,
        'content-range': `bytes ${start}-${end}/${size}`,
      })
      return response.end(part)
    }
    response.writeHead(200, { ...headers, 'content-length': size })
    return response.end(request.method === 'GET' ? object.data : undefined)
  }
  return xml(response, 405, 'MethodNotAllowed')
})

server.listen(PORT, '127.0.0.1', () => console.log(`fake S3 on http://127.0.0.1:${PORT}`))
