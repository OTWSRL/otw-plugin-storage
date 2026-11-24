/** What went wrong talking to a storage service, in words an administrator can act on. */
export class StorageError extends Error {
  /**
   * `auth`: the keys, or what they may do. `unavailable`: the service is down or too busy.
   * `network` and `timeout`: it couldn't be reached. `rejected`: it refused the request.
   */
  readonly code: 'auth' | 'unavailable' | 'network' | 'timeout' | 'rejected'
  /** The HTTP status, when the service answered. */
  readonly status: number | null
  /** The service's own error code, such as `SignatureDoesNotMatch`. */
  readonly reason: string | null

  constructor(
    code: StorageError['code'],
    message: string,
    details: { status?: number; reason?: string | null } = {},
  ) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.status = details.status ?? null
    this.reason = details.reason ?? null
  }

  /** Whether trying again later could work. */
  get retryable(): boolean {
    return this.code !== 'auth' && this.code !== 'rejected'
  }
}

export type Fetch = typeof fetch

/** How long the service has to answer with its headers; a body may take longer to stream. */
export const ANSWER_TIMEOUT_MS = 30_000
/** How long sending a file may take. */
export const SEND_TIMEOUT_MS = 5 * 60_000
/** How much of an error's body is read for its code. */
const ERROR_BODY_BYTES = 4096

function codeFor(status: number): StorageError['code'] {
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 429 || status >= 500) return 'unavailable'
  return 'rejected'
}

/** The `<Code>` of an S3 error document: a word such as `AccessDenied`, or nothing. */
export async function errorCodeOf(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).slice(0, ERROR_BODY_BYTES)
    const code = /<Code>([A-Za-z0-9._-]{1,80})<\/Code>/.exec(text)?.[1]
    return code ?? null
  } catch {
    return null
  }
}

/**
 * A storage service's refusal as an error. It carries the status and the service's own code and
 * nothing else of the answer: never a header, an address or a body that could hold a secret.
 */
export async function refusal(what: string, response: Response): Promise<StorageError> {
  const reason = await errorCodeOf(response)
  const detail = reason ? `${response.status}, ${reason}` : String(response.status)
  return new StorageError(codeFor(response.status), `The storage refused to ${what} (${detail}).`, {
    status: response.status,
    reason,
  })
}

/**
 * One request to the storage service. Redirects are errors, so signed headers never follow one
 * to another host. The timeout covers the wait for an answer's headers, not a body's download.
 */
export async function request(
  fetcher: Fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  timeoutMs = ANSWER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetcher(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: init.body as BodyInit } : {}),
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    // The cause may quote the address, which for a signed one is a secret: it isn't passed on.
    throw timedOut
      ? new StorageError('timeout', 'The storage took too long to answer.')
      : new StorageError('network', 'The storage couldn’t be reached.')
  } finally {
    clearTimeout(timer)
  }
}
