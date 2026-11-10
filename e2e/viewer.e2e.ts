import { expect, test, type Page } from '@playwright/test';
import type { IndexFile } from '../src/model.js';

/**
 * Runs against the demo data (scripts/demo-data.ts): 40 runs of
 * cinderblock/bindings-cpp on three OSes, with failures, flaky tests,
 * carryforward and patch coverage.
 */

let index: IndexFile;
test.beforeAll(async ({ request }) => {
  index = await (await request.get('data/index.json')).json();
});

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', e => list.push(e.message));
  page.on('console', m => {
    // The stubbed source host 404s on purpose (a private repo's case).
    if (
      m.type() === 'error' &&
      !m.location().url.includes('raw.githubusercontent.com')
    )
      list.push(m.text());
  });
  // Hermetic: source text comes from a stub, never the network.
  await page.route('https://raw.githubusercontent.com/**', route =>
    route.request().url().includes('/src/')
      ? route.fulfill({
          status: 200,
          body: Array.from({ length: 900 }, (_, i) => `// line ${i + 1}`).join(
            '\n',
          ),
        })
      : route.fulfill({ status: 404, body: '' }),
  );
});

test.afterEach(async ({ page }) => {
  // No hover-only tooltips anywhere.
  expect(await page.locator('[title]').count()).toBe(0);
  // Nothing wider than the screen (phone especially).
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors.get(page)).toEqual([]);
});

test('overview shows the latest run, trends and lists', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.brand')).toHaveText('cinderblock/bindings-cpp');
  await expect(page).toHaveTitle('cinderblock/bindings-cpp · stats');
  const tile = (label: string) =>
    page
      .locator('.tile')
      .filter({
        has: page.locator('.tile-label', { hasText: new RegExp(`^${label}$`) }),
      });
  await expect(tile('Lines')).toBeVisible();
  await expect(tile('Branches')).toBeVisible();
  await expect(tile('Patch')).toContainText('changed lines ran');
  await expect(
    page.getByRole('heading', { name: 'Tests', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.chart')).toHaveCount(2);
  await expect(
    page.locator('.chart').first().locator('rect.fill-pass').first(),
  ).toBeVisible();
  await expect(page.locator('.series polyline').first()).toBeVisible();
  await expect(page.locator('h2', { hasText: 'Flakiest tests' })).toBeVisible();
  await expect(page.locator('table.runs tbody tr')).toHaveCount(10);
  // Main branch by default: no PR rows.
  await expect(page.locator('table.runs .chip', { hasText: 'PR' })).toHaveCount(
    0,
  );
});

test('coverage breakdown by flag draws one line per flag', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('radio', { name: 'By flag' }).click();
  await expect(page.locator('.series')).toHaveCount(3);
  await expect(page.locator('.legend', { hasText: 'Windows' })).toBeVisible();
});

test('chart tooltip on hover or tap, with a link to the run', async ({
  page,
  isMobile,
}) => {
  await page.goto('./');
  const chart = page.locator('.chart').first();
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const at = { x: box.width - 20, y: box.height / 2 };
  if (isMobile) await chart.tap({ position: at });
  else await chart.hover({ position: at });
  const tip = page.locator('.tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('passed');
  await tip.getByRole('link', { name: 'Open run →' }).click();
  await expect(page).toHaveURL(/#\/runs\/\d+-1$/);
  await expect(page.locator('h1')).toContainText('Test #');
});

test('chart reads out runs from the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard');
  await page.goto('./');
  await page.locator('.chart').first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('.tooltip')).toContainText(
    index.runs.at(-1)!.sha.slice(0, 7),
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/runs/${index.runs.at(-1)!.key}$`));
});

test('branch filter includes PR runs', async ({ page }) => {
  await page.goto('./#/runs');
  await expect(page.locator('table.runs tbody tr')).toHaveCount(40);
  await page.getByLabel('Event').selectOption('pull_request');
  await expect(
    page.locator('table.runs .chip', { hasText: 'PR' }).first(),
  ).toBeVisible();
  const prs = index.runs.filter(r => r.event === 'pull_request').length;
  await expect(page.locator('table.runs tbody tr')).toHaveCount(prs);
});

test('a failing run shows its failures and messages', async ({ page }) => {
  const bad = index.runs.find(r => r.tests.failed > 0 && r.branch === 'main')!;
  await page.goto(`./#/runs/${bad.key}`);
  await expect(page.locator('h2', { hasText: 'Failures' })).toBeVisible();
  const item = page.locator('.failures li').first();
  await expect(item).toBeVisible();
  await item.getByText('Message').click();
  await expect(item.locator('pre.message')).toContainText('Error');
  await expect(page.locator('h2', { hasText: 'Jobs' })).toBeVisible();
  await expect(page.locator('h3', { hasText: 'Changed files' })).toBeVisible();
});

test('tests list searches, sorts and opens a test', async ({ page }) => {
  await page.goto('./#/tests?sort=flaky');
  await expect(page.locator('table.tests tbody tr').first()).toBeVisible();
  await page.getByLabel('Search').fill('backpressure');
  await expect(page.locator('table.tests tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'backpressure' }).click();
  await expect(page.locator('h1')).toHaveText('backpressure');
  await expect(page.locator('.tile', { hasText: 'Flips' })).toBeVisible();
  await expect(page.locator('.chart')).toHaveCount(1);
});

test('coverage tree drills into a directory and a file with source', async ({
  page,
}) => {
  await page.goto('./#/coverage');
  await expect(page.locator('h1')).toHaveText('Coverage');
  await expect(page.locator('table.tree tbody tr').first()).toBeVisible();
  await page.locator('table.tree a', { hasText: /^src\// }).click();
  await expect(page.locator('.crumbs b')).toHaveText('src');
  await page.locator('table.tree a', { hasText: 'serialport.cpp' }).click();
  await expect(page.locator('h2.path')).toHaveText('src/serialport.cpp');
  await expect(page.locator('.ln.hit').first()).toBeVisible();
  await expect(
    page.locator('.ln-src', { hasText: '// line 1' }).first(),
  ).toBeVisible();
  await expect(page.locator('.jumps .chip').first()).toBeVisible();
});

test('coverage flag filter changes the totals', async ({ page }) => {
  await page.goto('./#/coverage');
  const summary = page.locator('main p.muted').filter({ hasText: 'of lines' });
  const all = await summary.textContent();
  await page.locator('.chip.toggle', { hasText: 'Windows' }).click();
  await expect(page.locator('.chip.toggle.on')).toHaveText('Windows');
  await expect(summary).not.toHaveText(all!);
});

test('a file without reachable source still shows its lines', async ({
  page,
}) => {
  await page.goto('./#/coverage');
  await page.locator('table.tree a', { hasText: /^lib\// }).click();
  await page
    .locator('table.tree a')
    .filter({ hasText: /\.ts$/ })
    .first()
    .click();
  await expect(page.locator('.note')).toContainText(
    'Source text isn’t available',
  );
  await expect(page.locator('.ln').first()).toBeVisible();
});

test('unknown addresses and pruned detail are handled', async ({ page }) => {
  await page.goto('./#/nope');
  await expect(page.getByText('Nothing at this address')).toBeVisible();
  await page.goto('./#/runs/0-1');
  await expect(page.getByText('isn’t stored')).toBeVisible();
});
