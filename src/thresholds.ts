import type { RunCoverage } from './model.js';
import type { Ratio } from './coverage/model.js';

/**
 * Coverage rules, one per line of the `thresholds` input:
 *
 *     total: 80              line coverage of the whole run, at least 80%
 *     branches: 60           branch coverage, at least 60%
 *     patch: 70              changed lines that ran, at least 70%
 *     drop: 1                total may fall at most 1 point below the baseline
 *     component TypeScript: 85
 *     flag Windows: 60
 *
 * Blank lines and `#` comments are ignored.
 */
export type Rule =
  | { kind: 'total' | 'branches' | 'patch' | 'drop'; value: number }
  | { kind: 'component' | 'flag'; name: string; value: number };

/** Which commit status a rule reports under. */
export type StatusGroup = 'coverage' | 'patch';

export function parseThresholds(raw: string): Rule[] {
  const rules: Rule[] = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const text = line.replace(/(^|\s)#.*$/, '').trim();
    if (!text) continue;
    const m = text.match(/^(.+?)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*%?$/);
    if (!m)
      throw new Error(
        `thresholds line ${i + 1}: expected "name: number", got ${JSON.stringify(line)}`,
      );
    const key = m[1]!.trim();
    const value = Number(m[2]);
    const scoped = key.match(/^(component|flag)\s+(.+)$/i);
    if (scoped) {
      rules.push({
        kind: scoped[1]!.toLowerCase() as 'component' | 'flag',
        name: scoped[2]!.trim(),
        value: checkPct(value, i),
      });
      continue;
    }
    const kind = key.toLowerCase();
    if (kind === 'total' || kind === 'lines' || kind === 'project')
      rules.push({ kind: 'total', value: checkPct(value, i) });
    else if (kind === 'branches' || kind === 'patch')
      rules.push({ kind, value: checkPct(value, i) });
    else if (kind === 'drop') rules.push({ kind: 'drop', value });
    else
      throw new Error(
        `thresholds line ${i + 1}: unknown rule ${JSON.stringify(key)} (expected total, branches, patch, drop, "component <name>" or "flag <name>")`,
      );
  }
  return rules;
}

function checkPct(v: number, i: number): number {
  if (v > 100) throw new Error(`thresholds line ${i + 1}: ${v} is over 100%`);
  return v;
}

export interface RuleResult {
  rule: Rule;
  group: StatusGroup;
  /** Short name, e.g. `total`, `component TypeScript`. */
  label: string;
  /** Measured value: percent, or points dropped for `drop`. */
  actual?: number;
  /** undefined when there was nothing to measure (no patch, no such flag). */
  ok?: boolean;
  /** One line for people, e.g. `86.04% (min 80%)`. */
  text: string;
}

const exact = (r: Ratio) => (r.total ? (100 * r.hit) / r.total : undefined);
/** Floored to 2 places, like every other percentage we show. */
const show = (p: number) => `${(Math.floor(p * 100) / 100).toFixed(2)}%`;
const pts = (p: number) => `${(Math.round(p * 100) / 100).toFixed(2)} pts`;

export function ruleLabel(rule: Rule): string {
  return 'name' in rule ? `${rule.kind} ${rule.name}` : rule.kind;
}

/**
 * Evaluate rules against a run's coverage. `base` is the baseline run's
 * coverage, for `drop`. Rules with nothing to measure are reported with
 * `ok: undefined`, and never fail.
 */
export function evaluate(
  rules: Rule[],
  cov: RunCoverage | undefined,
  base: RunCoverage | undefined,
): RuleResult[] {
  return rules.map(rule => {
    const label = ruleLabel(rule);
    const group: StatusGroup = rule.kind === 'patch' ? 'patch' : 'coverage';
    const min = (r: Ratio | undefined): RuleResult => {
      const p = r ? exact(r) : undefined;
      if (p === undefined) return { rule, group, label, text: 'no data' };
      return {
        rule,
        group,
        label,
        actual: p,
        ok: p >= rule.value,
        text: `${show(p)} (min ${rule.value}%)`,
      };
    };
    switch (rule.kind) {
      case 'total':
        return min(cov?.totals.lines);
      case 'branches':
        return min(cov?.totals.branches);
      case 'patch':
        return min(cov?.patch);
      case 'component':
        return min(cov?.components[rule.name]?.lines);
      case 'flag':
        return min(cov?.flags[rule.name]?.lines);
      case 'drop': {
        const cur = cov ? exact(cov.totals.lines) : undefined;
        const was = base ? exact(base.totals.lines) : undefined;
        if (cur === undefined || was === undefined)
          return { rule, group, label, text: 'no baseline' };
        const d = Math.max(0, was - cur);
        return {
          rule,
          group,
          label,
          actual: d,
          // Tolerate float noise at exactly the limit.
          ok: d <= rule.value + 1e-9,
          text: `${cur < was ? `−${pts(was - cur)}` : `+${pts(cur - was)}`} vs baseline (max drop ${rule.value})`,
        };
      }
    }
  });
}

export interface StatusUpdate {
  context: string;
  state: 'success' | 'failure';
  /** At most 140 characters (GitHub's limit). */
  description: string;
}

export const STATUS_PREFIX = 'standalone-stats';

/** One commit status per group that has rules. A group whose rules all
 *  had no data passes, saying so. */
export function statusesFor(results: RuleResult[]): StatusUpdate[] {
  const out: StatusUpdate[] = [];
  for (const group of ['coverage', 'patch'] as const) {
    const rs = results.filter(r => r.group === group);
    if (!rs.length) continue;
    const failed = rs.filter(r => r.ok === false);
    const measured = rs.filter(r => r.ok !== undefined);
    const shown = failed.length ? failed : measured;
    let description = shown.length
      ? shown
          .map(r => (group === 'patch' ? r.text : `${r.label} ${r.text}`))
          .join('; ')
      : 'Nothing to measure';
    if (description.length > 140) description = `${description.slice(0, 139)}…`;
    out.push({
      context: `${STATUS_PREFIX}/${group}`,
      state: failed.length ? 'failure' : 'success',
      description,
    });
  }
  return out;
}

export const failedRules = (results: RuleResult[]) =>
  results.filter(r => r.ok === false);
