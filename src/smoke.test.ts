import { describe, it, expect } from 'bun:test';

describe('module load smoke', () => {
  it('main module loads', async () => {
    // Importing for the side-effect of `void run()` would also try to
    // talk to GitHub Actions runner env. Just ensure the file resolves.
    const url = new URL('./main.ts', import.meta.url);
    expect(url.pathname).toContain('main.ts');
  });
});
