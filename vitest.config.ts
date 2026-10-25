import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Give Vite a resolvable virtual-module target before vi.mock replaces it.
  // The real service worker is tested separately in production Playwright runs.
  resolve: {
    alias: {
      'virtual:pwa-register/react': resolve(
        import.meta.dirname,
        'node_modules/vite-plugin-pwa/dist/client/dev/react.js',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
