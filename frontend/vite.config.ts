/// <reference types="vitest/config" />
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** Removes the mock service worker from builds that don't use mocks, so it never ships to production. */
function stripMockWorker(keep: boolean): Plugin {
  let outDir = 'dist';
  return {
    name: 'codelens:strip-mock-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      if (!keep) await rm(resolve(outDir, 'mockServiceWorker.js'), { force: true });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useMocks = env.VITE_USE_MOCKS === 'true';

  return {
    plugins: [react(), stripMockWorker(useMocks)],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      proxy: useMocks
        ? undefined
        : {
            '/api': {
              target: env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
              changeOrigin: false,
            },
          },
    },
    build: {
      target: 'es2022',
      // No public source maps: they would expose the full source to anyone with the URL.
      sourcemap: false,
      // React, Radix, TanStack and the router make up the main chunk (~220 kB gzipped).
      chunkSizeWarningLimit: 800,
    },
    esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : undefined,
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
      env: { VITE_USE_MOCKS: 'true' },
    },
  };
});
