import type { Database, Logger, MediaApi, MediaItem } from '@otwdesign/sdk'
import { desc, eq, sql } from 'drizzle-orm'
import type { StorageConnection } from './drivers'
import { copyRuns, type CopyRun } from './schema'

/** Items gone through between two looks at the clock and the run's row. */
const BATCH = 10
/** How long one job works before it hands over to the next: well inside a function's time. */
const BUDGET_MS = 15_000
/** How many missing files' names a run remembers. */
export const MAX_MISSING_KEYS = 200

export interface CopyDependencies {
  db: () => Database
  logger: Logger
  media: Pick<MediaApi, 'list' | 'disk'>
  /** The storage to copy into, opened; throws with what's missing when it isn't ready. */
  connect(): Promise<StorageConnection>
  /** Queues the job that goes on with a run. */
  enqueue(run: string): Promise<unknown>
  now?: () => number
  budgetMs?: number
}

export interface CopyService {
  /** The newest run, for the screen. */
  latest(): Promise<CopyRun | null>
  /** Begins a run, unless one is under way: then that one is answered. */
  start(): Promise<CopyRun>
  cancel(): Promise<void>
  /** Goes on with a run for a while; queues itself again when there's more. A job's handler. */
  work(run: string): Promise<void>
}

/** Every file an item has: itself, its original and its sizes, each once. */
function filesOf(item: MediaItem): string[] {
  return [
    ...new Set([
      item.file,
      ...(item.originalFile ? [item.originalFile] : []),
      ...Object.values(item.sizes).map((size) => size.file),
    ]),
  ]
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer())
}

/**
 * Copies the uploads on the site's disk into the storage, for a site that had files before it
 * had a storage plugin. Safe to run again, and while people upload: a file the storage has is
 * left alone, and nothing on the disk is changed.
 */
export function createCopyService(deps: CopyDependencies): CopyService {
  const { logger, media } = deps
  const now = deps.now ?? (() => Date.now())
  const budget = deps.budgetMs ?? BUDGET_MS

  const latest = async () => {
    const [run] = await deps.db().select().from(copyRuns).orderBy(desc(copyRuns.startedAt)).limit(1)
    return run ?? null
  }

  /** One file: copied, there already, or not on the disk. */
  const copyFile = async (
    storage: StorageConnection,
    key: string,
    contentType: string,
  ): Promise<'copied' | 'skipped' | 'missing'> => {
    const onDisk = await media.disk.stat(key)
    if (!onDisk) return 'missing'
    const there = await storage.stat(key)
    if (there?.size === onDisk.size) return 'skipped'
    const file = await media.disk.read(key)
    if (!file) return 'missing'
    // A file of another size under the same key isn't written over: `create` says it's taken.
    return (await storage.create(key, await bytesOf(file.body), contentType)) ? 'copied' : 'skipped'
  }

  return {
    latest,

    async start() {
      const running = await latest()
      if (running?.status === 'running') return running
      // Fails here, with what's missing, rather than in a job nobody is watching.
      await deps.connect()
      const { total } = await media.list({ limit: 1 })
      // One run at a time, whoever presses the button: the table itself refuses a second.
      const [run] = await deps
        .db()
        .insert(copyRuns)
        .values({ total })
        .onConflictDoNothing()
        .returning()
      if (!run) return (await latest())!
      await deps.enqueue(run.id)
      return run
    },

    async cancel() {
      await deps
        .db()
        .update(copyRuns)
        .set({ status: 'cancelled', finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(copyRuns.status, 'running'))
    },

    async work(id) {
      const started = now()
      const find = async () => {
        const [run] = await deps.db().select().from(copyRuns).where(eq(copyRuns.id, id)).limit(1)
        return run ?? null
      }
      const finish = (status: CopyRun['status'], error: string | null = null) =>
        deps
          .db()
          .update(copyRuns)
          .set({ status, error, finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(copyRuns.id, id))

      let storage: StorageConnection
      try {
        storage = await deps.connect()
      } catch (error) {
        await finish('failed', error instanceof Error ? error.message : 'The storage isn’t ready.')
        return
      }

      for (;;) {
        // Read again each round: Cancel on the screen stops it here.
        const run = await find()
        if (!run || run.status !== 'running') return
        const { items } = await media.list({
          orderBy: 'date',
          order: 'asc',
          limit: BATCH,
          offset: run.position,
        })
        if (items.length === 0) {
          await finish('done', run.error)
          return
        }
        const counts = { copied: 0, skipped: 0, missing: 0, failed: 0 }
        const missingKeys = [...run.missingKeys]
        let problem = run.error
        for (const item of items) {
          for (const key of filesOf(item)) {
            try {
              const outcome = await copyFile(storage, key, item.mimeType)
              counts[outcome]++
              if (outcome === 'missing' && missingKeys.length < MAX_MISSING_KEYS) {
                missingKeys.push(key)
              }
            } catch (error) {
              // One file that can't go mustn't stop the rest; the screen says how many didn't.
              counts.failed++
              problem = error instanceof Error ? error.message : String(error)
              logger.error('Storage: a file could not be copied', { file: key, error })
            }
          }
        }
        await deps
          .db()
          .update(copyRuns)
          .set({
            position: run.position + items.length,
            copied: run.copied + counts.copied,
            skipped: run.skipped + counts.skipped,
            missing: run.missing + counts.missing,
            failed: run.failed + counts.failed,
            missingKeys,
            error: problem,
            updatedAt: sql`now()`,
          })
          .where(eq(copyRuns.id, id))
        if (now() - started >= budget) {
          await deps.enqueue(id)
          return
        }
      }
    },
  }
}
