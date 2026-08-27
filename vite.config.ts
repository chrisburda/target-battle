import { defineConfig } from 'vite';

/*
 * Served from a GitHub Pages project subpath
 * (chrisburda.github.io/target-battle/), so built asset URLs need that prefix.
 * Only the CI build sets it: locally the dev server and preview stay at the
 * root, and a stray base would break both.
 */
const BASE = process.env.GITHUB_ACTIONS ? '/target-battle/' : '/';

export default defineConfig({
  base: BASE,
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    // Source maps are ~3MB and only useful to whoever is debugging the build.
    // Visitors download the bundle, not the maps.
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
