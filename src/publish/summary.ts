import type { RunRecord } from '../model.js';
import type { Comparison } from './merge.js';

export interface SummaryLinks {
  siteUrl?: string;
  badgeUrl?: string;
  recorded: boolean;
  /** Why the run wasn't recorded, when it wasn't. */
  note?: string;
}

const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1');

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

  if (!record.uploads.length) {
    out.push('No test results were found for this run.', '');
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

    out.push(
      '| Job | Passed | Failed | Skipped | Time |',
      '| --- | ---: | ---: | ---: | ---: |',
    );
    for (const u of record.uploads) {
      const f = u.tests.failed + u.tests.errored;
      out.push(
        `| ${md(u.label)} | ${u.tests.passed} | ${f ? `**${f}**` : 0} | ${u.tests.skipped} | ${formatDuration(u.tests.durationMs)} |`,
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

  if (links.siteUrl) out.push(`Dashboard: ${links.siteUrl}`, '');
  if (links.note) out.push(`> ${links.note}`, '');
  else if (!links.recorded)
    out.push('> This run was compared but not recorded in history.', '');
  return out.filter(s => s !== undefined).join('\n');
}
