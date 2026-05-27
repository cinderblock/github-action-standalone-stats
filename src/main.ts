import * as core from '@actions/core';

/**
 * PLACEHOLDER IMPLEMENTATION.
 *
 * The action's intent (per action.yml + repo description) is to publish
 * coverage / test results / build stats into a side branch of the
 * consuming repo, for self-contained pretty charts and badges on
 * gh-pages. That logic has never been written.
 *
 * For now: log the declared inputs so consumers see the action is wired
 * up correctly, and exit successfully. Real implementation is TODO.
 */
async function run(): Promise<void> {
  try {
    const statsBranch = core.getInput('stats-branch');
    const statsRepo = core.getInput('stats-repo');
    const pagesDir = core.getInput('pages-dir');

    core.info(`stats-branch: ${statsBranch}`);
    core.info(`stats-repo: ${statsRepo || '(current repository)'}`);
    core.info(`pages-dir: ${pagesDir}`);
    core.warning(
      'github-action-standalone-stats has not yet been implemented. ' +
        'This action is a no-op placeholder; see the README.',
    );
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

void run();
