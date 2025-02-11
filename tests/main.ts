import { wait } from '../src/wait';
import { execSync, ExecSyncOptions } from 'node:child_process';
import { join } from 'node:path';

describe('standalone-stats', () => {
  test('throws invalid number', async () => {
    const input = parseInt('foo', 10);
    await expect(wait(input)).rejects.toThrow('milliseconds not a number');
  });

  test('wait 50 ms', async () => {
    const start = new Date();
    await wait(50);
    const end = new Date();
    const delta = Math.abs(end.getTime() - start.getTime());
    expect(delta).toBeGreaterThan(45);
  });

  if (process.env.GITHUB_ACTIONS) {
    // shows how the runner will run a javascript action with env / stdout protocol
    test('test runs', () => {
      process.env['INPUT_MILLISECONDS'] = '500';
      const ip = join(__dirname, '..', 'dist', 'index.js');
      const options: ExecSyncOptions = {
        env: process.env,
      };
      // eslint-disable-next-line no-console
      console.log(execSync(`node ${ip}`, options).toString());
    });
  }
});
