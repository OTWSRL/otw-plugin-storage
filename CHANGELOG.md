# @otwdesign/plugin-storage

## 1.1.1

### Patch Changes

- Security and speed, from a review of 1.1.0:

  - A storage's address, and the public address, can no longer be on the server's own network
    unless the site's environment says so (`STORAGE_ALLOW_PRIVATE_ENDPOINT=1`), and never a cloud's
    metadata address: a setting typed in the admin could make the site read internal services.
    `STORAGE_S3_SERVICE` and `STORAGE_S3_PATH_STYLE` pin the last two settings that had no variable.
  - Names are checked again before they become part of an address, for both drivers.
  - Answers from a storage are read with a limit on size and time.
  - From a bucket's own address, only pictures, audio, video, PDFs and plain text show in the
    browser; SVG, HTML and the like always download.
  - Looking first for a taken name claims it with a row, not a lock held across the upload: no
    database connection waits while a file is sent.
  - Vercel Blob: the store written to and the store linked to are always the same one; a range
    read stops once it has what was asked.
  - A file's address is worked out once per start of the site, not for every file on a page.
  - One copy runs at a time; the Status screen says when an address is plain http.

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
