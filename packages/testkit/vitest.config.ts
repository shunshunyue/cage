import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./src/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
  },
});
