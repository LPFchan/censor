import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// The suite runs inside workerd so the bundled WASM codecs (mozjpeg, UPNG)
// and the assets binding behave exactly as they do in production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // The pool's bundled workerd lags the compatibility_date in
      // wrangler.toml; nothing this Worker uses changed between the two.
      miniflare: { compatibilityDate: '2026-08-22' },
    }),
  ],
  test: {
    include: ['test/**/*.test.js'],
  },
});
