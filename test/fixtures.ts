import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginDefinition } from '@otwdesign/sdk'
import { createTestKernel, type TestKernel } from '@otwdesign/testing'
import { afterEach, vi } from 'vitest'
import storageAdmin from '../src/admin'
import storage from '../src/index'
import { KEYS, type FakeS3 } from './fake-s3'

let open: TestKernel[] = []
let folders: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(open.map((harness) => harness.close()))
  open = []
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  folders = []
})

export const bytes = (value: string) => new TextEncoder().encode(value)

/** The settings of a bucket on the tests' stand-in for S3, as a server of one's own. */
export const bucketSettings = (s3: FakeS3) => ({
  'storage.driver': 's3',
  'storage.s3_service': 'custom',
  'storage.s3_bucket': 'media',
  'storage.s3_region': 'us-east-1',
  'storage.s3_endpoint': s3.url,
  'storage.s3_path_style': true,
})

export const bucketEnv = {
  STORAGE_S3_ACCESS_KEY_ID: KEYS.accessKeyId,
  STORAGE_S3_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
}

export interface BootOptions {
  settings?: Record<string, unknown>
  env?: Record<string, string>
  plugins?: PluginDefinition[]
}

/** A site with the Storage plugin, its disk uploads in a folder of the test's own. */
export async function bootStorage(options: BootOptions = {}) {
  for (const [name, value] of Object.entries(options.env ?? {})) vi.stubEnv(name, value)
  const uploads = mkdtempSync(join(tmpdir(), 'storage-test-'))
  folders.push(uploads)
  const harness = await createTestKernel({
    plugins: [storage, ...(options.plugins ?? [])],
    admin: [storageAdmin],
    settings: { 'site.url': 'https://site.example', ...options.settings } as never,
    env: options.env,
    uploads: { dir: uploads },
  })
  open.push(harness)
  const admin = await harness.signIn('administrator')
  return {
    harness,
    kernel: harness.kernel,
    admin,
    uploads,
    /** Posts one of the plugin's admin forms as the administrator. */
    act: (name: string, form: Record<string, string> = {}) =>
      harness.request('POST', harness.kernel.actionUrl('storage', name), {
        form,
        cookie: admin.cookie,
      }),
  }
}
