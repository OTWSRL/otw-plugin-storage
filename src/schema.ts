import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Where a run of "Copy Files to Storage" stands. */
export type CopyStatus = 'running' | 'done' | 'cancelled' | 'failed'

/**
 * One run of copying the disk's uploads into the storage: how far it has got, and what it found.
 * It's done a batch at a time, by a job that picks up where the last left off.
 */
export const copyRuns = pgTable('storage_copy_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status').$type<CopyStatus>().notNull().default('running'),
  /** How many of the library's items have been gone through, oldest first. */
  position: integer('position').notNull().default(0),
  /** The library's items when the run began. */
  total: integer('total').notNull().default(0),
  copied: integer('copied').notNull().default(0),
  /** Files the storage already had. */
  skipped: integer('skipped').notNull().default(0),
  /** Files that weren't on the disk either. */
  missing: integer('missing').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  /** The first of the missing files' keys, for the report. */
  missingKeys: jsonb('missing_keys').$type<string[]>().notNull().default([]),
  /** The last thing that went wrong, in words. */
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export type CopyRun = typeof copyRuns.$inferSelect
