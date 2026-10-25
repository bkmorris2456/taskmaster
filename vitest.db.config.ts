import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/database/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 40_000,
    fileParallelism: false,
  },
});
