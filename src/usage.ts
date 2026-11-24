import type { Database } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'

/** What the media library holds, from its own records. */
export interface MediaUsage {
  /** Uploads in the library. */
  items: number
  /** Files they're kept as: each upload's own, and each image size's. */
  files: number
  /** The files' sizes, added up. */
  bytes: number
  /**
   * Images kept with an untouched original beside a scaled copy. The CMS records no size for
   * those originals, so they aren't in `bytes` or `files`.
   */
  uncountedOriginals: number
}

const GB = 1024 * 1024 * 1024
/** The largest limit taken: more is a typing mistake. */
const MAX_LIMIT_GB = 1_000_000
/** From this share of the limit, the page warns. */
const NEAR = 0.9

/**
 * How much the media library holds: one query over the CMS's own table of uploads, with no
 * request to the storage. An image size's file is counted once, however many size names share it.
 */
export async function mediaUsage(db: Database): Promise<MediaUsage> {
  const result = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM cms_media) AS items,
      (SELECT coalesce(sum(size), 0) FROM cms_media) AS item_bytes,
      (SELECT count(*) FROM cms_media WHERE original_file IS NOT NULL) AS originals,
      sized.files AS size_files,
      sized.bytes AS size_bytes
    FROM (
      SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes
      FROM (
        SELECT DISTINCT
          entry.value ->> 'file' AS file,
          -- A size that isn't a number counts as nothing, where a cast would fail the page.
          CASE WHEN entry.value ->> 'size' ~ '^[0-9]{1,18}$'
            THEN (entry.value ->> 'size')::bigint ELSE 0 END AS size
        FROM cms_media, jsonb_each(cms_media.sizes) AS entry
      ) AS distinct_files
    ) AS sized
  `)) as unknown as { rows: Record<string, string | number>[] }
  const row = result.rows[0] ?? {}
  const number = (name: string) => Number(row[name] ?? 0)
  return {
    items: number('items'),
    files: number('items') + number('size_files'),
    bytes: number('item_bytes') + number('size_bytes'),
    uncountedOriginals: number('originals'),
  }
}

/** A count that took this long is kept: the library is large enough for counting to cost. */
const SLOW_MS = 50
/** How long a kept count is given out before the library is counted again. */
const KEEP_MS = 5 * 60 * 1000

/** A count of the library, and when it was made. */
export interface CountedUsage extends MediaUsage {
  countedAt: Date
}

/**
 * Counts the library when asked, and keeps a count for five minutes only when making it was
 * slow. A small library's figure is always current; a large one's costs its query once in a while.
 */
export function createUsageCounter(
  count: () => Promise<MediaUsage>,
  options: { slowMs?: number; keepMs?: number; now?: () => number } = {},
): () => Promise<CountedUsage> {
  const slowMs = options.slowMs ?? SLOW_MS
  const keepMs = options.keepMs ?? KEEP_MS
  const now = options.now ?? (() => Date.now())
  let kept: CountedUsage | null = null
  return async () => {
    if (kept && now() - kept.countedAt.getTime() < keepMs) return kept
    const started = now()
    const counted = { ...(await count()), countedAt: new Date(started) }
    kept = now() - started >= slowMs ? counted : null
    return counted
  }
}

/**
 * The limit typed in Settings › Storage, in bytes: a number of GB, decimals allowed. `null` for
 * none, and `'invalid'` for what isn't a number above zero.
 */
export function parseLimit(text: string | undefined): number | null | 'invalid' {
  const typed = (text ?? '').trim().replace(',', '.')
  if (typed === '') return null
  const gigabytes = Number(typed)
  if (!/^\d+(\.\d+)?$/.test(typed) || !(gigabytes > 0) || gigabytes > MAX_LIMIT_GB) return 'invalid'
  return Math.round(gigabytes * GB)
}

/** A size as people read it: `340 KB`, `12.4 MB`, `1.2 GB`. 1 GB is 1,024 MB, as elsewhere in the CMS. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // One decimal below ten of a unit and for anything in MB and up; whole numbers of KB.
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1))
  return `${shown} ${units[unit]}`
}

/** Where the space used stands against the limit. */
export function usageLevel(bytes: number, limitBytes: number | null): 'ok' | 'near' | 'over' {
  if (limitBytes === null) return 'ok'
  if (bytes >= limitBytes) return 'over'
  return bytes >= limitBytes * NEAR ? 'near' : 'ok'
}

/** The share of the limit used, as a whole percentage. */
export function percentUsed(bytes: number, limitBytes: number): number {
  return Math.round((bytes / limitBytes) * 100)
}
