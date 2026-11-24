import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export const KEYS = { accessKeyId: 'fake-access-key', secretAccessKey: 'fake-secret-key' }
export const SITE_ORIGIN = 'https://site.example'

export interface StoredObject {
  key: string
  size: number
  type: string
  cache: string | null
  disposition: string | null
}

export interface FakeS3 {
  /** Its address, such as `http://127.0.0.1:51234`. */
  url: string
  /** How it treats `If-None-Match: *`, and whether its CORS rules let the site's pages in. */
  control(state: { conditional?: 'honour' | 'reject' | 'ignore'; cors?: boolean }): Promise<void>
  objects(): Promise<StoredObject[]>
  clear(): Promise<void>
}

const running: ChildProcess[] = []
afterAll(() => {
  for (const child of running.splice(0)) child.kill()
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** Starts the stand-in for S3 the e2e tests use (site/e2e/fake-s3.mjs), stopped after the file. */
export async function startFakeS3(): Promise<FakeS3> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../site/e2e/fake-s3.mjs', import.meta.url))],
    {
      env: { ...process.env, FAKE_S3_PORT: String(port), FAKE_S3_ALLOWED_ORIGIN: SITE_ORIGIN },
      stdio: 'ignore',
    },
  )
  running.push(child)
  for (let tries = 0; ; tries++) {
    const up = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) break
    if (tries > 100) throw new Error('The fake S3 did not start')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return {
    url,
    async control(state) {
      await fetch(`${url}/__control`, { method: 'POST', body: JSON.stringify(state) })
    },
    objects: async () => (await (await fetch(`${url}/__objects`)).json()) as StoredObject[],
    async clear() {
      await fetch(`${url}/__objects`, { method: 'DELETE' })
      await fetch(`${url}/__control`, {
        method: 'POST',
        body: JSON.stringify({ conditional: 'honour', cors: true }),
      })
    },
  }
}
