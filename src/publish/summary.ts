import type { RunCoverage, RunRecord } from '../model.js';
import { formatPct, pct, type CovTotals, type Ratio } from '../coverage/model.js';
import type { Comparison } from './merge.js';

export interface SummaryLinks {
  siteUrl?: string;
  badgeUrl?: string;
  coverageBadgeUrl?: string;
  recorded: boolean;
  /** Why the run wasn't recorded, when it wasn't. */
  note?: string;
}

const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1');
/** For inside a code span, where backslash escapes don't work. */
const code = (s: string) => `\`${s.replace(/[`|]/g, '?')}\``;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

const LIST_LIMIT = 25;

/** Percentage-point change, e.g. `+1.25`, or '' when either side is n/a. */
function deltaPct(cur: Ratio, base: Ratio | undefined): string {
  const a = pct(cur);
  const b = base ? pct(base) : undefined;
  if (a === undefined || b === undefined) return '';
  const d = Math.round((a - b) * 100) / 100;
  if (d === 0) return '±0%';
  return `${d > 0 ? '+' : ''}${d.toFixed(2)}%`;
}

const ratio = (r: Ratio) =>
  r.total ? `${formatPct(r)} (${r.hit}/${r.total})` : 'n/a';

function breakdown(
  title: string,
  cur: Record<string, CovTotals & { carried?: true }>,
  base: Record<string, CovTotals> | undefined,
): string[] {
  const names = Object.keys(cur);
  if (!names.length) return [];
  const withBase = !!base;
  const out = [
    `| ${title} | Lines |${withBase ? ' Δ |' : ''} Branches | Files |`,
    `| --- | ---: |${withBase ? ' ---: |' : ''} ---: | ---: |`,
  ];
  for (const n of names) {
    const c = cur[n]!;
    const d = withBase
      ? ` ${base?.[n] ? deltaPct(c.lines, base[n].lines) : 'new'} |`
      : '';
    out.push(
      `| ${md(n)}${c.carried ? ' (carried forward)' : ''} | ${ratio(c.lines)} |${d} ${ratio(c.branches)} | ${c.files} |`,
    );
  }
  out.push('');
  return out;
}

export function renderCoverage(
  cov: RunCoverage,
  base: RunCoverage | undefined,
  baseSha: string | undefined,
  badge?: string,
  siteUrl?: string,
): string[] {
  const out: string[] = ['### Coverage', ''];
  if (badge && siteUrl) out.push(`[![coverage](${badge})](${siteUrl})`, '');
  const t = cov.totals;
  const d = base ? deltaPct(t.lines, base.totals.lines) : '';
  const bits = [
    `**Lines ${ratio(t.lines)}**${d ? ` (${d} vs \`${baseSha?.slice(0, 7)}\`)` : ''}`,
    t.branches.total ? `branches ${ratio(t.branches)}` : '',
    `${t.files} files`,
  ].filter(Boolean);
  out.push(bits.join(' · '), '');
  if (cov.patch) {
    const p = cov.patch;
    out.push(
      p.total
        ? `**Patch ${ratio(p)}**: changed lines that ran${p.partial ? ' (diff incomplete: too many files)' : ''}.`
        : 'Patch: no coverable lines changed.',
      '',
    );
  }
  if (cov.carriedForward.length)
    out.push(
      `Carried forward from the baseline (not run this time): ${cov.carriedForward.map(code).join(', ')}.`,
      '',
    );
  if (Object.keys(cov.components).length > 1)
    out.push(...breakdown('Component', cov.components, base?.components));
  out.push(...breakdown('Flag', cov.flags, base?.flags));
  const missed = cov.patch?.files.filter(f => f.hit < f.total) ?? [];
  if (missed.length) {
    const rows = missed
      .slice(0, LIST_LIMIT)
      .map(f => `| ${code(f.path)} | ${ratio(f)} | ${f.total - f.hit} |`);
    out.push(
      `<details><summary>Changed files with uncovered lines (${missed.length})</summary>`,
      '',
      '| File | Patch | Missed |',
      '| --- | ---: | ---: |',
      ...rows,
      '',
      missed.length > LIST_LIMIT
        ? `…and ${missed.length - LIST_LIMIT} more\n`
        : '',
      '</details>',
      '',
    );
  }
  return out;
}

function list(title: string, ids: string[]): string {
  if (!ids.length) return '';
  const shown = ids.slice(0, LIST_LIMIT).map(id => `- ${md(id)}`);
  if (ids.length > LIST_LIMIT)
    shown.push(`- …and ${ids.length - LIST_LIMIT} more`);
  return `<details><summary>${title} (${ids.length})</summary>\n\n${shown.join('\n')}\n\n</details>\n`;
}

/** Markdown for the job summary. Plain GFM, so it also works as a PR
 *  comment body later. */
export function renderSummary(
  record: RunRecord,
  cmp: Comparison | undefined,
  links: SummaryLinks,
): string {
  const t = record.tests.totals;
  const bad = t.failed + t.errored;
  const out: string[] = ['## Standalone Stats', ''];

  if (links.badgeUrl && links.siteUrl)
    out.push(`[![tests](${links.badgeUrl})](${links.siteUrl})`, '');

  const hasTests = record.uploads.some(u => u.tests.total > 0);
  if (!record.uploads.length) {
    out.push('No test results or coverage were found for this run.', '');
  } else if (!hasTests) {
    // Coverage-only run; the section below says it all.
  } else {
    const parts = [
      `${bad ? '❌' : '✅'} **${t.passed}** passed`,
      bad ? `**${bad}** failing` : '',
      t.skipped ? `${t.skipped} skipped` : '',
      t.other ? `${t.other} other` : '',
    ].filter(Boolean);
    const jobs = record.uploads.length;
    out.push(
      `${parts.join(' · ')} — ${t.total} results from ${record.tests.unique} tests across ${jobs} job${jobs === 1 ? '' : 's'}, ${formatDuration(t.durationMs)} total`,
      '',
    );
    if (record.tests.flaky)
      out.push(`⚠️ ${record.tests.flaky} flaky (passed on retry)`, '');

    if (cmp) {
      const sha = cmp.baseSha.slice(0, 7);
      const bits = [
        cmp.newFailures.length
          ? `**${cmp.newFailures.length} new failure${cmp.newFailures.length === 1 ? '' : 's'}**`
          : 'no new failures',
        cmp.fixed.length ? `${cmp.fixed.length} fixed` : '',
        cmp.stillFailing.length
          ? `${cmp.stillFailing.length} still failing`
          : '',
        cmp.delta.total ? `${signed(cmp.delta.total)} results` : '',
      ].filter(Boolean);
      out.push(`Compared with \`${sha}\`: ${bits.join(', ')}.`, '');
    }

    const covCol = record.uploads.some(u => u.coverage);
    out.push(
      `| Job | Passed | Failed | Skipped | Time |${covCol ? ' Lines |' : ''}`,
      `| --- | ---: | ---: | ---: | ---: |${covCol ? ' ---: |' : ''}`,
    );
    for (const u of record.uploads) {
      const f = u.tests.failed + u.tests.errored;
      const c = covCol
        ? ` ${u.coverage ? formatPct(u.coverage.lines) : ''} |`
        : '';
      out.push(
        `| ${md(u.label)} | ${u.tests.passed} | ${f ? `**${f}**` : 0} | ${u.tests.skipped} | ${formatDuration(u.tests.durationMs)} |${c}`,
      );
    }
    out.push('');

    if (cmp) {
      out.push(list('New failures', cmp.newFailures));
      out.push(list('Fixed', cmp.fixed));
    }
    const failures = record.tests.failures;
    if (failures.length) {
      const labels = new Map(record.uploads.map(u => [u.key, u.label]));
      const rows = failures.slice(0, LIST_LIMIT).map(f => {
        const where = f.uploads.map(k => labels.get(k) ?? k).join(', ');
        const msg = f.message
          ? `\n\n  \`\`\`\n  ${f.message.split('\n').slice(0, 8).join('\n  ')}\n  \`\`\``
          : '';
        return `- **${md(f.id)}** (${md(where)})${msg}`;
      });
      const more =
        record.tests.failuresTruncated || failures.length > LIST_LIMIT
          ? '\n- …more in the dashboard'
          : '';
      out.push(
        `<details><summary>Failures (${failures.length}${record.tests.failuresTruncated ? '+' : ''})</summary>\n\n${rows.join('\n')}${more}\n\n</details>\n`,
      );
    }
  }

  if (record.coverage)
    out.push(
      ...renderCoverage(
        record.coverage,
        cmp?.coverage?.baseRun.coverage,
        cmp?.baseSha,
        links.coverageBadgeUrl,
        links.siteUrl,
      ),
    );

  if (links.siteUrl) out.push(`Dashboard: ${links.siteUrl}`, '');
  if (links.note) out.push(`> ${links.note}`, '');
  else if (!links.recorded)
    out.push('> This run was compared but not recorded in history.', '');
  // Empty optional sections leave runs of blank lines; collapse them.
  return out
    .filter(s => s !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
