import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Recursively copy `src` into `dst`. Creates `dst` if missing. Overwrites
 *  files at the destination. No-op if `src` doesn't exist. */
export async function copyDir(src: string, dst: string): Promise<void> {
  if (!existsSync(src)) return;
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true, force: true });
}
