import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// The dashboard's suite against the Rust API (service/crates/api) instead of
// today's server: the same built app, served same-origin by the API's fake
// example (synthetic live data, no chain). `npm -w web run test:e2e:rust`.
export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:8894', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && cd service && cargo run -q -p mpamm-api --example fake -- 8894',
    env: { WEB_DIST: fileURLToPath(new URL('./dist', import.meta.url)), E2E_BACKEND: 'rust' },
    cwd: fileURLToPath(new URL('../', import.meta.url)), url: 'http://127.0.0.1:8894/api/health', reuseExistingServer: false,
    timeout: 600_000,
  },
});
