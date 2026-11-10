// Bundles both action entry points, then builds the dashboard (a Vite +
// React app in viewer/) into dist/viewer, which publish copies to Pages.
// dist/ is committed: GitHub runs it directly, with no install step.
import { rm } from 'node:fs/promises';
import { build as viteBuild } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });

// One build with code splitting: both entries share a chunk, instead of
// each carrying its own copy of @actions/* (~3 MB).
const result = await Bun.build({
  entrypoints: [`${root}src/publish/main.ts`, `${root}src/collect/main.ts`],
  root: `${root}src`,
  target: 'node',
  format: 'esm',
  splitting: true,
  naming: { entry: '[dir]/[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
  outdir: dist,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const o of result.outputs)
  console.log(
    `${o.path.slice(root.length).replace(/\\/g, '/')}: ${(o.size / 1024).toFixed(0)} KiB`,
  );

await viteBuild({
  configFile: `${root}viewer/vite.config.ts`,
  logLevel: 'warn',
});
console.log('dist/viewer/');
