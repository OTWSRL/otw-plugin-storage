# Storage for OTW CMS

Keeps the media library's files in object storage, for sites whose host has no disk to keep them
on, such as Vercel. Large files go from the browser straight to the storage, so a host's limit on
a request's size (Vercel: 4.5 MB) doesn't cap uploads.

- **S3 and what speaks its protocol**: Amazon S3, Cloudflare R2, Supabase Storage, and a server of
  your own running MinIO, Garage or `rclone serve s3`. Over plain `fetch`, with no SDK.
- **Vercel Blob**, through its own SDK, which is loaded only when that store is used.
- **Another driver**, added by a small plugin of your own to the `storage.drivers` registry.

Needs OTW CMS 1.9 or later.

## Install

```sh
npx cms plugin add @otwdesign/plugin-storage
```

Then, in the admin:

1. **Storage › Settings**: choose the service and fill in its bucket. Its keys go in the site's
   environment (below), never in the database.
2. **Storage › Status › Test the Connection**: stores a small file of its own, reads it back,
   checks a second one can't replace it and that browsers may send files, then deletes it.
3. If the site already has uploads on its disk: **Tools › Copy Files to Storage**.
4. **Storage › Settings › Keep uploads in this storage**: from then on, uploads go to the bucket.

Until step 4 the plugin changes nothing: uploads stay on the disk, on the paths they always took.

## Services

| Service          | What to enter                               | Never writing over a file                      |
| ---------------- | ------------------------------------------- | ---------------------------------------------- |
| Amazon S3        | bucket, region                              | the service refuses (`If-None-Match`)          |
| Cloudflare R2    | bucket, account ID                          | the service refuses                            |
| Supabase Storage | bucket, project reference, region           | looked for first, under a lock                 |
| Another          | bucket, region, address, path or host style | your choice; looking first is the safe default |
| Vercel Blob      | public or private, as the store was made    | the store refuses                              |

Two uploads of `photo.jpg` must become `photo.jpg` and `photo-1.jpg`, never one file. Where a
service doesn't refuse a second write itself, the plugin looks first, holding a lock in the
site's database (`pg_advisory_xact_lock`) so two servers can't both find the name free. The
connection test says whether a service refuses.

### The keys may need

For S3: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on the bucket's objects, and
`s3:ListBucket` on the bucket, without which a missing file looks forbidden (403) instead of
missing (404).

### Uploads from the browser (CORS)

For files of 4 MB or more the browser sends the bytes to the bucket itself, at an address the
site signs for that one file, for fifteen minutes. The bucket must allow the site's pages:

```json
[
  {
    "AllowedOrigins": ["https://www.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

The file waits under `_uploads/` as plain bytes, which nothing serves. The site then reads it
back, checks its type from its bytes, makes an image's sizes, stores it under its own name and
deletes the one that waited. A waiting file that's never finished is deleted when it runs out;
a lifecycle rule that expires `_uploads/` after a day is a good second net.

Without CORS rules, set **Uploads from the browser** to "Every file goes through the site":
uploads then work up to the host's limit on a request.

### Serving files

With a **public address** (a CDN's, a custom domain's, `pub-….r2.dev`), files are linked there
directly. Without one the bucket can stay private: the site serves `/uploads/…` from it, with
ranges, at the cost of a request to the bucket per file. Links to `/uploads/…` saved in content
keep working either way.

### Space used

**Storage › Status** says how much the media library holds: the size of every upload and every
image size made from one, from the CMS's own records, with no request to the bucket. Set **Storage
limit, in GB** to your plan's quota and it shows the share used, warns from 90% and says when
it's passed. It never stops an upload: your provider enforces its own limit.

It counts this site's library, not the bucket: not files the library doesn't know (another site's,
or an upload still waiting), and not the untouched originals the CMS keeps of images over 2560
pixels, which it says when there are any. Object storage has no "free space" to ask for; a
plan's real quota is in the provider's own console.

### A server of your own, or a PC

Run something that speaks S3 on it (MinIO, Garage, or `rclone serve s3` over a folder), choose
"Another, or a server of your own", and enter its address. It must be reachable from the site,
and from browsers too for uploads over the host's limit, and it must stay on: when it's off,
the site's images are too. A PC that sleeps is better as a copy of a bucket (`rclone sync`) than
as the storage.

## Environment variables

| Variable                                                                              | For                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `STORAGE_S3_ACCESS_KEY_ID`                                                            | The bucket's access key ID. Required for S3.                           |
| `STORAGE_S3_SECRET_ACCESS_KEY`                                                        | Its secret. Required for S3.                                           |
| `BLOB_READ_WRITE_TOKEN`                                                               | Vercel Blob's token; Vercel sets it when a store is connected.         |
| `BLOB_STORE_ID`                                                                       | The Blob store's id, with Vercel's OIDC sign-in instead of a token.    |
| `VERCEL_OIDC_TOKEN`                                                                   | Set by Vercel; with `BLOB_STORE_ID`, signs in to Blob without a token. |
| `STORAGE_ACTIVE`                                                                      | `true` or `false`: overrides "Keep uploads in this storage".           |
| `STORAGE_DRIVER`                                                                      | `s3`, `vercel-blob` or `plugin`: overrides the choice.                 |
| `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCOUNT`, `STORAGE_S3_ENDPOINT` | Override the bucket's settings.                                        |
| `STORAGE_PUBLIC_URL`                                                                  | Overrides the public address.                                          |
| `STORAGE_PREFIX`                                                                      | Overrides the folder inside the bucket.                                |

A setting with its variable set shows read-only in the admin. The two keys and the token are
read from the environment only.

## For other plugins

```ts
// A driver of your own: it appears when Settings › Storage says "A driver another plugin adds".
cms.registries.get('storage.drivers').add({
  id: 'attic',
  label: 'The attic',
  directUploads: false,
  problem: () => null, // or what's missing, in a sentence
  publicUrl: (key) => null, // or the file's address
  connect: async () => ({ create, read, stat, delete: remove }),
})

cms.services.get('storage').status() // { active, driver, problem }
await cms.services.get('storage').usage() // { items, files, bytes, limitBytes, … }
```

`create()` must never write over a file: it answers `false` when the key is taken.

## Limits

- A file sent straight to storage is read into memory once to be checked and stored, so the
  practical ceiling is the server's memory. Fine at the CMS's default 64 MB.
- Switching is one way. Turned off again, files uploaded to the bucket since stay there, and the
  site looks for them on the disk.
- Copying runs where the files are. Run it on the old server (or locally, against the site's
  database) before moving to a host without a disk.
- Vercel Blob can't set whether a file shows or downloads; S3 services get that from its type.

## Deleting its data

**Plugins › Storage › Delete Data** drops its one table (`storage_copy_runs`). Files in the
bucket are not touched.

## Developing

```sh
pnpm install          # the CMS is linked from ../nextjs-cms
pnpm test:all         # lint, types, unit tests, and browser tests against a production build
```

The unit and browser tests run against `site/e2e/fake-s3.mjs`, a stand-in for S3 that checks
every request's signature (ports 3500 and 3501 for the browser tests). The signer itself is held
to Amazon's own (`@smithy/signature-v4`) in `test/sigv4.test.ts`.

## License

Apache-2.0
