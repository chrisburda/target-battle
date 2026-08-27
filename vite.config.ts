import { defineConfig } from 'vite';

/*
 * Served from a GitHub Pages project subpath
 * (chrisburda.github.io/wild-watts/), so built asset URLs need that prefix.
 *
 * It follows the repository name, so the two have to move together: GitHub
 * redirects a renamed repository but not its Pages site, and a stale base here
 * would 404 every script and model on the new address.
 * Only the CI build sets it: locally the dev server and preview stay at the
 * root, and a stray base would break both.
 */
const BASE = process.env.GITHUB_ACTIONS ? '/wild-watts/' : '/';

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
