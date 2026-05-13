// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30000,
  retries: 1,
  use: {
    headless: true,
    viewport: { width: 420, height: 900 },
  },
  // Only run files matching ux.spec
  testMatch: ['ux.spec.js'],
});
