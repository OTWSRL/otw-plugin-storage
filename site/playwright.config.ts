import { defineConfig, devices } from '@playwright/test'

const PORT = 3500
/** The stand-in for S3: another origin than the site's, so a browser's upload is cross-origin. */
export const S3_PORT = 3501
export const S3_URL = `http://127.0.0.1:${S3_PORT}`
const SITE = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // One server on one embedded database, set up by the first test.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: SITE,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/fake-s3.mjs',
      url: `${S3_URL}/health`,
      reuseExistingServer: false,
      env: {
        FAKE_S3_PORT: String(S3_PORT),
        // The bucket's CORS rules: this site's pages may send it files.
        FAKE_S3_ALLOWED_ORIGIN: SITE,
      },
    },
    {
      // A fresh database and uploads folder each run, so the first visit sets the site up.
      command: `node -e "for (const dir of ['.data/e2e', '.data/e2e-uploads']) fs.rmSync(dir, { recursive: true, force: true })" && pnpm build && pnpm start --port ${PORT}`,
      url: SITE,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        CMS_DATA_DIR: '.data/e2e',
        CMS_UPLOADS_DIR: '.data/e2e-uploads',
        DATABASE_URL: '',
        SITE_URL: SITE,
        // The stand-in's keys, from the environment as a real bucket's are.
        // The stand-in is on this machine: the server says a storage on its own network is meant.
        STORAGE_ALLOW_PRIVATE_ENDPOINT: '1',
        STORAGE_S3_ACCESS_KEY_ID: 'fake-access-key',
        STORAGE_S3_SECRET_ACCESS_KEY: 'fake-secret-key',
      },
    },
  ],
})
