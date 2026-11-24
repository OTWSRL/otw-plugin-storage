import { describe, expect, it } from 'vitest'
import { errorCodeOf, readCapped, refusal } from '../src/http'

/** A body that never ends: a megabyte each time it's asked, counting how often. */
function endless() {
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(1024 * 1024).fill(120))
    },
  })
  return { body, pulls: () => pulls }
}

describe('reading what a storage answers', () => {
  it('takes the start of a body and lets go of the rest, however long it is', async () => {
    const { body, pulls } = endless()
    const text = await readCapped(new Response(body), 4096)
    expect(text).toHaveLength(4096)
    expect(pulls()).toBeLessThan(5)
  })

  it('finds an error’s code at the start of an answer, and nothing in an endless one', async () => {
    const error = new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', {
      status: 403,
    })
    expect(await errorCodeOf(error)).toBe('AccessDenied')
    const { body, pulls } = endless()
    expect(await errorCodeOf(new Response(body, { status: 500 }))).toBeNull()
    expect(pulls()).toBeLessThan(5)
  })

  it('says a refusal with its status and code, and nothing else of the answer', async () => {
    const answer = new Response(
      '<Error><Code>SignatureDoesNotMatch</Code><StringToSign>secret-looking-text</StringToSign></Error>',
      { status: 403 },
    )
    const error = await refusal('store a file', answer)
    expect(error.message).toBe('The storage refused to store a file (403, SignatureDoesNotMatch).')
    expect(JSON.stringify(error)).not.toContain('secret-looking-text')
  })
})
