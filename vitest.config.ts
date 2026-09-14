import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/server/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    coverage: {
      reporter: ['text', 'json-summary'],
    },
  },
});
