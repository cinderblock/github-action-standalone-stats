// Other packages https://github.com/actions/toolkit/blob/master/README.md#packages
import { debug, getInput, setOutput, setFailed } from '@actions/core';

import { wait } from './wait.js';

async function run(): Promise<void> {
  try {
    const ms: string = getInput('milliseconds');
    debug(`Waiting ${ms} milliseconds ...`);

    debug(new Date().toTimeString());
    await wait(parseInt(ms, 10));
    debug(new Date().toTimeString());

    setOutput('time', new Date().toTimeString());
  } catch (error) {
    setFailed(error instanceof Error ? error.message : String(error));
  }
}

void run();
