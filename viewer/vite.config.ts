import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = import.meta.dirname;

/**
 * In dev, serve a stats directory's `data/` and `badges/` next to the app,
 * the way Pages serves them in production. `STATS_DIR` picks the directory;
 * the default is the demo data from `bun run viewer:demo`.
 */
function statsData(): Plugin {
  const dir = resolve(process.env.STATS_DIR ?? join(here, '.demo'));
  return {
    name: 'stats-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]!);
        if (!/^\/(data|badges)\//.test(url)) return next();
        const file = normalize(join(dir, url));
        if (
          !file.startsWith(dir) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader(
          'content-type',
          file.endsWith('.svg') ? 'image/svg+xml' : 'application/json',
        );
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: here,
  // Relative asset URLs: the viewer is served from any stats subdir.
  base: './',
  plugins: [react(), statsData()],
  build: {
    outDir: join(here, '..', 'dist', 'viewer'),
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
    reportCompressedSize: false,
  },
});
