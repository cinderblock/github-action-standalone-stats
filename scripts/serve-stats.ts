/**
 * Serves a stats directory the way Pages does, with the built viewer laid
 * over it: `bun scripts/serve-stats.ts [statsDir] [port]`. Defaults to the
 * demo data (`bun run viewer:demo`) and `dist/viewer` (`bun run build`).
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stats = resolve(process.argv[2] ?? join(root, 'viewer', '.demo'));
const viewer = join(root, 'dist', 'viewer');
const port = Number(process.argv[3] ?? process.env.PORT ?? 4719);

function find(path: string): string | undefined {
  for (const base of [stats, viewer]) {
    const f = normalize(join(base, path));
    if (!f.startsWith(base)) return undefined;
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return undefined;
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const f = find(path);
    return f
      ? new Response(Bun.file(f))
      : new Response('Not found', { status: 404 });
  },
});
console.log(
  `Serving ${stats} + ${viewer} at http://${server.hostname}:${server.port}/`,
);
