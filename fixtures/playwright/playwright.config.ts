import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Assign PORT before running this fixture');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: { baseURL, browserName: 'chromium' },
  projects: [{ name: 'chromium' }],
  webServer: { command: 'node server.mjs', url: baseURL, reuseExistingServer: false },
});
