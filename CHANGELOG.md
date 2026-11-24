# @otwdesign/plugin-storage

## 1.1.0

### Minor Changes

- The Status screen says how much the media library holds, from the CMS's own records, and
  compares it with a limit you set (Storage limit, in GB): a warning from 90%, and a notice once
  it's passed. `cms.services.get('storage').usage()` gives the same to other plugins.

## 1.0.1

### Patch Changes

- Every setting and the `storage.manage` capability carry a description, for the CMS's reference.

## 1.0.0

### Major Changes

- Storage for OTW CMS's media library: S3, Cloudflare R2, Supabase Storage, a server of your own,
  or Vercel Blob. Large files go from the browser straight to the storage, past a host's limit on
  a request's size. A connection test, a tool that copies the disk's uploads across, and a registry
  for other drivers.
