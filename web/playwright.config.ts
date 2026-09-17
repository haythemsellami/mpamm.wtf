import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:8893', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm -w server run start',
    env: { DATA_SOURCE: 'sim', API_PORT: '8893', QUOTE_INTERVAL_MS: '300', VENUES: '', WEB_DIST: fileURLToPath(new URL('./dist', import.meta.url)) },
    cwd: fileURLToPath(new URL('../', import.meta.url)), url: 'http://127.0.0.1:8893/api/health', reuseExistingServer: false,
  },
});
