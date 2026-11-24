import { expect, test, type Page } from '@playwright/test'
import { S3_URL } from '../playwright.config'

// One site, set up by the first test; the rest build on it, in order: files uploaded to the
// disk, a bucket set up and tested, the files copied across, then uploads switched to it.
test.describe.configure({ mode: 'serial' })

const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'a strong e2e password' }
/** A minimal PNG: one pixel. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
/** Over Vercel's 4.5 MB: a file no request through such a site could carry. */
const LARGE = Buffer.alloc(5 * 1024 * 1024, 'The quick brown fox jumps over the lazy dog.\n')

interface Stored {
  key: string
  size: number
  type: string
}
const bucket = async () => (await (await fetch(`${S3_URL}/__objects`)).json()) as Stored[]
const steer = (state: object) =>
  fetch(`${S3_URL}/__control`, { method: 'POST', body: JSON.stringify(state) })

const notice = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
/** A row of an admin form table, which is laid out as a table without being one to a reader. */
const row = (page: Page, label: string) =>
  page.locator('tr').filter({ has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) })

async function signIn(page: Page) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expect(page).toHaveURL(/\/admin(\?|$)/)
}

/** The upload requests a page makes, as `METHOD address`, ids left out. */
function uploadRequests(page: Page) {
  const seen: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const upload = url.pathname.startsWith('/api/p/core/media') && request.method() !== 'GET'
    if (!upload && url.origin !== S3_URL) return
    const path = url.pathname.replace(/[0-9a-f-]{36}/, ':id')
    seen.push(`${request.method()} ${url.origin === S3_URL ? 'bucket' : ''}${path}`)
  })
  return seen
}

async function upload(page: Page, files: { name: string; buffer: Buffer }[]) {
  await page.goto('/admin/media/new')
  await page
    .locator('#media-files')
    .setInputFiles(files.map((file) => ({ ...file, mimeType: 'application/octet-stream' })))
  return page.getByRole('list', { name: 'Uploads' })
}

test('before the plugin is set up, uploads are on the disk as on any site', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL('/admin/setup')
  await page.getByLabel('Name').fill(ADMIN.name)
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await notice(page, 'Your site is ready.')

  const requests = uploadRequests(page)
  const uploads = await upload(page, [{ name: 'Before.png', buffer: PIXEL }])
  await expect(uploads.getByRole('link', { name: 'Edit' })).toHaveCount(1)
  expect(requests).toEqual(['POST /api/p/core/media'])
  expect(await bucket()).toEqual([])

  await page.goto('/admin/storage')
  await expect(row(page, 'Uploads are kept')).toContainText('On the server’s disk')
  await expect(row(page, 'Storage')).toContainText('Not ready: Enter the bucket’s name.')
})

test('the settings show one service’s fields at a time, and its keys come from the environment', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/admin/storage/settings')
  await expect(page.getByLabel('Where', { exact: true })).toHaveValue('s3')
  await expect(page.getByLabel('Service')).toHaveValue('aws')
  await expect(page.getByLabel('Region')).toBeVisible()
  await expect(page.getByLabel('Address', { exact: true })).toBeHidden()
  await expect(page.getByLabel('Account or project')).toBeHidden()
  await expect(page.getByLabel('The store is')).toBeHidden()
  // Never typed in, never shown.
  await expect(row(page, 'Access key ID')).toContainText('Configured')
  await expect(row(page, 'Secret access key')).toContainText('Configured')
  await expect(page.getByText('fake-secret-key')).toHaveCount(0)

  await page.getByLabel('Service').selectOption('r2')
  await expect(page.getByLabel('Account or project')).toBeVisible()
  await expect(page.getByLabel('Region')).toBeHidden()
  await page.getByLabel('Where', { exact: true }).selectOption('vercel-blob')
  await expect(page.getByLabel('The store is')).toBeVisible()
  await expect(page.getByLabel('Bucket', { exact: true })).toBeHidden()

  // A server of one's own: the stand-in, at its own address.
  await page.getByLabel('Where', { exact: true }).selectOption('s3')
  await page.getByLabel('Service').selectOption('custom')
  await page.getByLabel('Bucket', { exact: true }).fill('media')
  await page.getByLabel('Region').fill('us-east-1')
  await page.getByLabel('Address', { exact: true }).fill(S3_URL)
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')

  await page.goto('/admin/storage')
  await expect(row(page, 'Storage')).toContainText('S3, ready')
  await expect(row(page, 'Uploads are kept')).toContainText('On the server’s disk')
  await expect(row(page, 'Files are served')).toContainText('Through this site, at /uploads/')
})

test('the connection test tries the bucket out, and says what’s wrong with it', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/admin/storage')
  await page.getByRole('button', { name: 'Test the Connection' }).click()
  await notice(page, 'The storage passed all 8 checks.')
  const last = page.getByRole('region', { name: 'Last test' })
  await expect(last.getByRole('listitem')).toHaveCount(8)
  await expect(last).toContainText(
    'Passed: Take an upload at a signed address. Browsers on http://localhost:3500 can upload straight to it.',
  )
  expect(await bucket()).toEqual([])

  // A bucket whose CORS rules don't name the site.
  await steer({ cors: false })
  await page.getByRole('button', { name: 'Test the Connection' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '1 of 8 checks failed' })).toContainText(
    'CORS rules don’t let http://localhost:3500 send files',
  )
  await expect(last).toContainText('Failed: Take an upload at a signed address')
  await steer({ cors: true })
})

test('the disk’s files are copied to the bucket, in the background', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/storage/copy')
  await expect(page.getByRole('heading', { name: 'Copy Files to Storage' })).toBeVisible()
  await page.getByRole('button', { name: 'Copy Files to S3' }).click()
  await notice(page, 'Copying has begun, in the background.')
  const run = page.getByRole('region', { name: 'Last run' })
  await expect(async () => {
    await page.goto('/admin/storage/copy')
    await expect(run.getByRole('status')).toContainText(
      /^Finished .+: \d+ copied, 0 already there\.$/,
    )
  }).toPass()
  const stored = await bucket()
  expect(stored.map((object) => object.key)).toContainEqual(
    expect.stringMatching(/^media\/\d{4}\/\d{2}\/before\.png$/),
  )
  expect(stored.every((object) => object.type === 'image/png')).toBe(true)
})

test('switched on, large files go from the browser straight to the bucket', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/storage/settings')
  await page.getByLabel('Keep uploads in this storage').check()
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')
  await page.goto('/admin/storage')
  await expect(row(page, 'Uploads are kept')).toContainText('In S3')
  await expect(row(page, 'Uploads from the browser')).toContainText(
    'Files of 4 MB or more go straight to storage',
  )

  const requests = uploadRequests(page)
  const uploads = await upload(page, [
    { name: 'Large Notes.txt', buffer: LARGE },
    { name: 'After.png', buffer: PIXEL },
  ])
  await expect(uploads.getByRole('link', { name: 'Edit' })).toHaveCount(2)
  expect(requests).toEqual([
    // The large file: the site signs an address, the browser sends the bytes to the bucket
    // (after asking its leave, which isn't listed among a page's requests), and the site
    // stores what arrived.
    'POST /api/p/core/media/uploads',
    'PUT bucket/media/_uploads/:id',
    'POST /api/p/core/media/uploads/:id/complete',
    // The small one goes through the site, in one request.
    'POST /api/p/core/media',
  ])
  const stored = await bucket()
  expect(stored).toContainEqual(
    expect.objectContaining({ size: LARGE.byteLength, type: 'text/plain' }),
  )
  expect(stored.some((object) => object.key.includes('_uploads/'))).toBe(false)
  expect(stored.map((object) => object.key)).toContainEqual(expect.stringMatching(/\/after\.png$/))

  // Files are served through the site from the bucket: the one copied earlier, and the new.
  await page.goto('/admin/media?mode=list')
  const table = page.getByRole('table', { name: 'Media Library' })
  await expect(table.getByRole('row')).toHaveCount(4)
  for (const name of ['before.png', 'after.png']) {
    const key = stored.find((object) => object.key.endsWith(`/${name}`))!.key
    const served = await page.request.get(`/uploads/${key.replace(/^media\//, '')}`)
    expect(served.status()).toBe(200)
    expect(served.headers()['content-type']).toBe('image/png')
  }
  // A file waiting to be checked is never served.
  expect((await page.request.get('/uploads/_uploads/anything')).status()).toBe(404)
})

test('a bucket that won’t take the browser’s file says so, and nothing is left of it', async ({
  page,
}) => {
  await signIn(page)
  await steer({ cors: false })
  const before = (await bucket()).length
  const uploads = await upload(page, [{ name: 'Refused.txt', buffer: LARGE }])
  await expect(uploads.getByRole('alert')).toContainText(
    'The file couldn’t be sent to storage. If every file fails, the storage doesn’t accept uploads from this site',
  )
  await steer({ cors: true })
  expect(await bucket()).toHaveLength(before)
})

test('deleting a file takes it out of the bucket', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/media?mode=list&s=large')
  await page
    .getByRole('table', { name: 'Media Library' })
    .getByRole('link', { name: /\(Edit\)$/ })
    .click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await notice(page, 'Media file permanently deleted.')
  await expect
    .poll(async () => (await bucket()).some((object) => object.key.endsWith('large-notes.txt')))
    .toBe(false)
})
