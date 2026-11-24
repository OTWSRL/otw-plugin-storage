import type { Migration } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'

/** The plugin's tables, for "Delete Data" to drop. */
export const TABLES = ['storage_copy_runs', 'storage_claims'] as const

export const migrations: readonly Migration[] = [
  {
    // Runs of "Copy Files to Storage": where each stands, and what it found.
    id: '0001_copy_runs',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE storage_copy_runs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          status text NOT NULL DEFAULT 'running',
          position integer NOT NULL DEFAULT 0,
          total integer NOT NULL DEFAULT 0,
          copied integer NOT NULL DEFAULT 0,
          skipped integer NOT NULL DEFAULT 0,
          missing integer NOT NULL DEFAULT 0,
          failed integer NOT NULL DEFAULT 0,
          missing_keys jsonb NOT NULL DEFAULT '[]',
          error text,
          started_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz
        )
      `)
    },
  },
  {
    // Names being written this moment, on services that don't refuse a second write themselves:
    // a claim is a row, so nothing holds a database connection while a file is sent. And one
    // copy at a time, whoever presses the button.
    id: '0002_claims',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE storage_claims (
          key text PRIMARY KEY,
          expires_at timestamptz NOT NULL
        )
      `)
      await db.execute(sql`
        CREATE UNIQUE INDEX storage_copy_runs_running_idx
          ON storage_copy_runs ((status)) WHERE status = 'running'
      `)
    },
  },
]
