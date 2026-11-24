import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { describeUsage } from '../src/admin'
import {
  createUsageCounter,
  formatSize,
  mediaUsage,
  parseLimit,
  percentUsed,
  usageLevel,
} from '../src/usage'
import { startFakeS3, type FakeS3 } from './fake-s3'
import { bootStorage, bucketEnv, bucketSettings, bytes } from './fixtures'

const GB = 1024 ** 3
let s3: FakeS3
beforeAll(async () => {
  s3 = await startFakeS3()
})
beforeEach(() => s3.clear())

const image = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#2271b1' } })
      .jpeg()
      .toBuffer(),
  )
const inBucket = () => ({ ...bucketSettings(s3), 'storage.active': true })

describe('the space the media library uses', () => {
  it('is nothing for an empty library', async () => {
    const { kernel } = await bootStorage()
    expect(await mediaUsage(kernel.db)).toEqual({
      items: 0,
      files: 0,
      bytes: 0,
      uncountedOriginals: 0,
    })
  })

  it('is exactly what the bucket holds: every upload and every image size, each file once', async () => {
    const { kernel } = await bootStorage({ settings: inBucket(), env: bucketEnv })
    await kernel.media.upload({ name: 'Beach.jpg', data: await image(800, 600) })
    const note = await kernel.media.upload({ name: 'notes.txt', data: bytes('packing list') })
    const stored = await s3.objects()
    const total = stored.reduce((sum, object) => sum + object.size, 0)
    expect(stored.length).toBeGreaterThan(2)
    expect(await kernel.service('storage').usage()).toEqual({
      items: 2,
      files: stored.length,
      bytes: total,
      uncountedOriginals: 0,
      limitBytes: null,
      countedAt: expect.any(Date),
    })

    await kernel.media.delete(note.id)
    const usage = await kernel.service('storage').usage()
    expect(usage).toMatchObject({ items: 1, files: stored.length - 1, bytes: total - 12 })
  })

  it('counts a file once when several size names share it', async () => {
    const { kernel } = await bootStorage()
    // As an image whose medium and large sizes came out the same file.
    await kernel.db.execute(`
      INSERT INTO cms_media (file, filename, mime_type, size, sizes) VALUES (
        '2026/11/a.jpg', 'a.jpg', 'image/jpeg', 1000,
        '{"thumbnail": {"file": "2026/11/a-150x150.jpg", "width": 150, "height": 150, "mimeType": "image/jpeg", "size": 100},
          "medium": {"file": "2026/11/a-300x200.jpg", "width": 300, "height": 200, "mimeType": "image/jpeg", "size": 300},
          "large": {"file": "2026/11/a-300x200.jpg", "width": 300, "height": 200, "mimeType": "image/jpeg", "size": 300}}'
      )`)
    expect(await mediaUsage(kernel.db)).toEqual({
      items: 1,
      files: 3,
      bytes: 1400,
      uncountedOriginals: 0,
    })
  })

  it('counts a size that isn’t a number as nothing, where the page would fail', async () => {
    const { kernel } = await bootStorage()
    await kernel.db.execute(`
      INSERT INTO cms_media (file, filename, mime_type, size, sizes) VALUES (
        '2026/11/b.jpg', 'b.jpg', 'image/jpeg', 1000,
        '{"thumbnail": {"file": "2026/11/b-150x150.jpg", "size": "lots"},
          "medium": {"file": "2026/11/b-300x200.jpg"}}'
      )`)
    expect(await mediaUsage(kernel.db)).toMatchObject({ items: 1, files: 3, bytes: 1000 })
  })

  it('says how many untouched originals it can’t count', async () => {
    const { kernel } = await bootStorage({ settings: inBucket(), env: bucketEnv })
    // Over 2560 pixels: kept as a scaled copy, with the original beside it.
    const item = await kernel.media.upload({ name: 'Wide.jpg', data: await image(3000, 200) })
    expect(item.originalFile).not.toBeNull()
    const usage = await mediaUsage(kernel.db)
    expect(usage.uncountedOriginals).toBe(1)
    const stored = await s3.objects()
    const original = stored.find((object) => object.key === `media/${item.originalFile}`)!
    // Everything but that original is counted.
    expect(usage.files).toBe(stored.length - 1)
    expect(usage.bytes).toBe(stored.reduce((sum, object) => sum + object.size, 0) - original.size)
  })

  it('answers within a blink for a large library', async () => {
    const { kernel } = await bootStorage()
    await kernel.db.execute(`
      INSERT INTO cms_media (file, filename, mime_type, size, sizes)
      SELECT 'f/' || n || '.jpg', n || '.jpg', 'image/jpeg', 500000,
        jsonb_build_object(
          'thumbnail', jsonb_build_object('file', 'f/' || n || '-150x150.jpg', 'size', 9000),
          'medium', jsonb_build_object('file', 'f/' || n || '-300x200.jpg', 'size', 30000),
          'large', jsonb_build_object('file', 'f/' || n || '-1024x683.jpg', 'size', 150000))
      FROM generate_series(1, 20000) AS n`)
    const started = performance.now()
    const usage = await mediaUsage(kernel.db)
    const took = performance.now() - started
    expect(usage).toMatchObject({ items: 20000, files: 80000, bytes: 20000 * 689000 })
    expect(took).toBeLessThan(1000)
  })
})

describe('counting a large library', () => {
  const usage = { items: 1, files: 1, bytes: 1, uncountedOriginals: 0 }

  /** A count that takes `takes` ms on a clock the test moves. */
  function counter(takes: () => number) {
    let clock = 1_000_000
    let counts = 0
    const count = createUsageCounter(
      async () => {
        counts++
        clock += takes()
        return { ...usage, items: counts }
      },
      { now: () => clock },
    )
    return { count, counts: () => counts, pass: (ms: number) => (clock += ms) }
  }

  it('counts every time while counting is quick, so the figure is always current', async () => {
    const quick = counter(() => 10)
    expect((await quick.count()).items).toBe(1)
    expect((await quick.count()).items).toBe(2)
    expect(quick.counts()).toBe(2)
  })

  it('keeps a slow count for five minutes, and says when it was made', async () => {
    const slow = counter(() => 60)
    const first = await slow.count()
    slow.pass(4 * 60_000)
    const again = await slow.count()
    expect(again).toBe(first)
    expect(slow.counts()).toBe(1)
    slow.pass(61_000)
    const later = await slow.count()
    expect(later.items).toBe(2)
    expect(later.countedAt.getTime()).toBeGreaterThan(first.countedAt.getTime())
  })

  it('stops keeping once counting is quick again', async () => {
    let takes = 60
    const changing = counter(() => takes)
    await changing.count()
    changing.pass(6 * 60_000)
    takes = 5
    await changing.count()
    await changing.count()
    expect(changing.counts()).toBe(3)
  })
})

describe('the limit typed in the settings', () => {
  it('is a number of GB, decimals allowed, or nothing', () => {
    expect(parseLimit('')).toBeNull()
    expect(parseLimit(undefined)).toBeNull()
    expect(parseLimit('  ')).toBeNull()
    expect(parseLimit('5')).toBe(5 * GB)
    expect(parseLimit(' 0.5 ')).toBe(GB / 2)
    expect(parseLimit('0,5')).toBe(GB / 2)
  })

  it.each(['0', '-1', 'five', '5GB', '1e3', '2000000', '1.2.3'])('refuses %s', (typed) => {
    expect(parseLimit(typed)).toBe('invalid')
  })

  it('is left out of the usage when it isn’t a number', async () => {
    const { kernel } = await bootStorage({ settings: { 'storage.limit_gb': 'lots' } })
    expect((await kernel.service('storage').usage()).limitBytes).toBeNull()
    const set = await bootStorage({ settings: { 'storage.limit_gb': '2' } })
    expect((await set.kernel.service('storage').usage()).limitBytes).toBe(2 * GB)
  })

  it('warns from nine tenths, and says when it’s passed', () => {
    expect(usageLevel(GB, null)).toBe('ok')
    expect(usageLevel(0.89 * GB, GB)).toBe('ok')
    expect(usageLevel(0.9 * GB, GB)).toBe('near')
    expect(usageLevel(GB, GB)).toBe('over')
    expect(usageLevel(2 * GB, GB)).toBe('over')
    expect(percentUsed(GB / 4, GB)).toBe(25)
  })
})

describe('sizes as people read them', () => {
  it.each([
    [0, '0 B'],
    [900, '900 B'],
    [1024, '1 KB'],
    [348_160, '340 KB'],
    [13_002_342, '12.4 MB'],
    [1.2 * GB, '1.2 GB'],
    [5 * GB, '5 GB'],
    [150 * GB, '150 GB'],
    [3000 * GB, '2.9 TB'],
  ])('%d bytes is %s', (size, text) => {
    expect(formatSize(size)).toBe(text)
  })

  it('puts the space used in a sentence, with and without a limit', () => {
    const usage = { items: 120, files: 340, bytes: 1.2 * GB, uncountedOriginals: 0 }
    expect(describeUsage(usage, null)).toBe('1.2 GB in 340 files (120 items)')
    expect(describeUsage(usage, 5 * GB)).toBe('1.2 GB of 5 GB (24%), in 340 files (120 items)')
    expect(describeUsage({ ...usage, items: 1, files: 1, bytes: 2048 }, null)).toBe(
      '2 KB in 1 file (1 item)',
    )
  })
})
