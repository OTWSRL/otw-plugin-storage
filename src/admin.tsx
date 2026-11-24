import { FormField, FormTable, Notice } from '@otwdesign/admin-ui'
import { ActionError, defineAdmin } from '@otwdesign/sdk'
import type { CheckResult } from './check'
import storage, { internalsOf } from './index'
import type { CopyRun } from './schema'

const MANAGE = 'storage.manage'
/** Where the last connection test's results wait for the Status screen. */
const LAST_CHECK = 'last-check'
const DAY = 24 * 60 * 60

interface LastCheck {
  at: string
  results: CheckResult[]
}

/** The site's own origin, from Settings › General: what a bucket's CORS rules must name. */
function originOf(address: string | undefined): string | null {
  try {
    return address ? new URL(address).origin : null
  } catch {
    return null
  }
}

function when(date: Date | string): string {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** A run of the copy, in a sentence. */
export function describeRun(run: CopyRun): string {
  const counts = [
    `${run.copied} copied`,
    `${run.skipped} already there`,
    ...(run.missing > 0 ? [`${run.missing} not on the disk`] : []),
    ...(run.failed > 0 ? [`${run.failed} failed`] : []),
  ].join(', ')
  const of = `${Math.min(run.position, run.total)} of ${run.total} items`
  switch (run.status) {
    case 'running':
      return `Copying: ${of} gone through so far (${counts}).`
    case 'done':
      return `Finished ${when(run.finishedAt ?? run.updatedAt)}: ${counts}.`
    case 'cancelled':
      return `Cancelled after ${of} (${counts}).`
    case 'failed':
      return `Stopped: ${run.error ?? 'the storage wasn’t ready'}.`
  }
}

export default defineAdmin(storage, (cms) => {
  const { driver, active, directFrom, copy, check } = internalsOf(cms.services.get('storage'))
  const chosen = () => {
    const found = driver()
    return typeof found === 'string'
      ? { label: null, problem: found, direct: false, publicUrl: null }
      : {
          label: found.label,
          problem: found.problem(),
          direct: found.directUploads,
          publicUrl: found.publicUrl('…'),
        }
  }

  cms.admin.page({
    name: 'status',
    path: '/',
    title: 'Storage',
    capability: MANAGE,
    menu: { label: 'Status', order: 10 },
    load: async () => ({
      state: chosen(),
      active: active(),
      directFrom: directFrom(),
      last: (await cms.cache.get<LastCheck>(LAST_CHECK, { durable: true })) ?? null,
    }),
    component: ({ data: { state, active: on, directFrom: from, last } }) => (
      <>
        {on && state.problem && (
          <Notice type="error">
            <p>
              Uploads are set to go to this storage, but it isn’t ready: {state.problem} Until then,
              uploads fail and stored files don’t show.
            </p>
          </Notice>
        )}
        <p>
          Where the media library keeps its files. <a href={cms.admin.url('/settings')}>Settings</a>
        </p>
        <FormTable>
          <FormField label="Uploads are kept">
            {on
              ? `In ${state.label ?? 'the storage chosen'}`
              : 'On the server’s disk: this storage is set up, but not switched on'}
          </FormField>
          <FormField label="Storage">
            {state.problem ? `Not ready: ${state.problem}` : `${state.label}, ready`}
          </FormField>
          <FormField label="Files are served">
            {state.publicUrl
              ? `From its public address: ${state.publicUrl.replace(/…$/, '')}`
              : 'Through this site, at /uploads/'}
          </FormField>
          <FormField label="Uploads from the browser">
            {!state.direct || from === null
              ? 'Every file goes through the site'
              : from === 0
                ? 'Every file goes straight to storage'
                : `Files of ${Math.round(from / (1024 * 1024))} MB or more go straight to storage`}
          </FormField>
        </FormTable>

        <h2>Test the connection</h2>
        <p>
          Stores a small file of its own, reads it back, checks that a second one can’t replace it
          and that browsers may send files, then deletes it. Nothing of the site’s is touched.
        </p>
        <form method="post" action={cms.admin.actionUrl('test-connection')}>
          <p className="submit">
            <button type="submit" className="button">
              Test the Connection
            </button>
          </p>
        </form>
        {last && (
          <section aria-label="Last test">
            <h3>Last test, {when(last.at)}</h3>
            <ul className="ul-disc">
              {last.results.map((result) => (
                <li key={result.step}>
                  <strong>{result.ok ? 'Passed' : 'Failed'}:</strong> {result.step}
                  {result.detail ? `. ${result.detail}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    ),
  })

  cms.admin.action({
    name: 'test-connection',
    capability: MANAGE,
    handler: async () => {
      const results = await check(originOf(cms.settings.get('site.url')))
      const last: LastCheck = { at: new Date().toISOString(), results }
      await cms.cache.set(LAST_CHECK, last, { durable: true, ttlSeconds: 30 * DAY })
      const failed = results.filter((result) => !result.ok)
      if (failed.length > 0) {
        throw new ActionError(
          `${failed.length} of ${results.length} checks failed. ${failed[0]!.step}: ${failed[0]!.detail ?? ''}`,
        )
      }
      return { notice: `The storage passed all ${results.length} checks.` }
    },
  })

  // ── Copying the disk's uploads across ───────────────────────────────────────

  cms.admin.page({
    name: 'copy',
    path: '/copy',
    title: 'Copy Files to Storage',
    capability: MANAGE,
    menu: { label: 'Copy Files to Storage', parent: 'tools', order: 60 },
    load: async () => ({ run: await copy.latest(), state: chosen(), active: active() }),
    component: ({ data: { run, state, active: on } }) => (
      <>
        <p>
          Copies the uploads on this server’s disk into the storage, for a site that had files
          before it had this plugin. Files the storage already has are left alone, nothing on the
          disk is changed, and it can be run again.
        </p>
        <p>
          Run it on the server that has the files, before switching uploads to the storage: a host
          such as Vercel has no disk to copy from.
        </p>
        {on && (
          <Notice type="info">
            <p>
              Uploads already go to the storage. Files still only on the disk don’t show until
              they’re copied.
            </p>
          </Notice>
        )}
        {state.problem ? (
          <Notice type="warning">
            <p>
              The storage isn’t ready: {state.problem}{' '}
              <a href={cms.admin.url('/settings')}>Settings</a>
            </p>
          </Notice>
        ) : run?.status === 'running' ? (
          <form method="post" action={cms.admin.actionUrl('cancel-copy')}>
            <p className="submit">
              <button type="submit" className="button">
                Cancel
              </button>
            </p>
          </form>
        ) : (
          <form method="post" action={cms.admin.actionUrl('start-copy')}>
            <p className="submit">
              <button type="submit" className="button button-primary">
                Copy Files to {state.label}
              </button>
            </p>
          </form>
        )}
        {run && (
          <section aria-label="Last run">
            <h2>{run.status === 'running' ? 'Under way' : 'Last run'}</h2>
            <p role="status">{describeRun(run)}</p>
            {run.status === 'running' && (
              <p>
                It goes on in the background. <a href={cms.admin.url('/copy')}>Refresh</a> to see
                how far it has got.
              </p>
            )}
            {run.failed > 0 && run.error && <p>The last failure: {run.error}</p>}
            {run.missingKeys.length > 0 && (
              <>
                <h3>
                  Not on the disk
                  {run.missing > run.missingKeys.length
                    ? ` (the first ${run.missingKeys.length} of ${run.missing})`
                    : ''}
                </h3>
                <p>The library lists these files, but the disk doesn’t have them.</p>
                <ul className="ul-disc">
                  {run.missingKeys.map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </>
    ),
  })

  cms.admin.action({
    name: 'start-copy',
    capability: MANAGE,
    handler: async () => {
      try {
        await copy.start()
      } catch (error) {
        cms.logger.error('Storage: the copy could not start', { error })
        const why = error instanceof Error ? error.message : 'see the server’s log'
        throw new ActionError(`The copy couldn’t start: ${why}`)
      }
      return { redirect: cms.admin.url('/copy'), notice: 'Copying has begun, in the background.' }
    },
  })

  cms.admin.action({
    name: 'cancel-copy',
    capability: MANAGE,
    handler: async () => {
      await copy.cancel()
      return { redirect: cms.admin.url('/copy'), notice: 'The copy was cancelled.' }
    },
  })

  // ── Settings ────────────────────────────────────────────────────────────────

  cms.admin.settingsPage({
    name: 'settings',
    path: '/settings',
    title: 'Storage Settings',
    capability: MANAGE,
    menu: { label: 'Settings', parent: 'storage', order: 20 },
  })
  cms.admin.settingsSection({
    name: 'where',
    page: 'storage.settings',
    title: 'Where files are kept',
    fields: ['storage.driver', 'storage.active'],
    link: { label: 'Test the Connection', url: cms.admin.url('/') },
  })
  cms.admin.settingsSection({
    name: 's3',
    page: 'storage.settings',
    title: 'The bucket',
    order: 20,
    showWhen: { setting: 'storage.driver', is: 's3' },
    fields: [
      'storage.s3_service',
      'storage.s3_bucket',
      'storage.s3_account',
      'storage.s3_region',
      'storage.s3_endpoint',
      'storage.s3_path_style',
      'storage.s3_no_overwrite',
      'storage.s3_access_key_id',
      'storage.s3_secret_access_key',
      'storage.public_url',
    ],
  })
  cms.admin.settingsSection({
    name: 'blob',
    page: 'storage.settings',
    title: 'The Blob store',
    order: 30,
    showWhen: { setting: 'storage.driver', is: 'vercel-blob' },
    fields: ['storage.blob_access', 'storage.blob_token'],
  })
  cms.admin.settingsSection({
    name: 'files',
    page: 'storage.settings',
    title: 'Files',
    order: 40,
    fields: ['storage.prefix', 'storage.direct_uploads', 'storage.cache'],
  })
})
