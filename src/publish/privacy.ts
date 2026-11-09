import type { PagesInfo } from '../github.js';

/**
 * A Pages site is public unless the repo is on Enterprise Cloud with
 * access-controlled Pages. Stats from a private repo published there would
 * expose test names, file paths and failure messages to anyone. So for a
 * private target repo whose Pages serves our branch publicly, refuse unless
 * the owner explicitly opted in.
 */
export interface PrivacyInput {
  targetPrivate: boolean;
  pages: PagesInfo;
  branch: string;
  allowPublic: boolean;
}

export type PrivacyDecision =
  | { ok: true; warning?: string }
  | { ok: false; reason: string };

export function checkPrivacy(i: PrivacyInput): PrivacyDecision {
  if (!i.targetPrivate || i.allowPublic) return { ok: true };
  const p = i.pages;
  if (p.state === 'none') return { ok: true };
  if (p.state === 'unknown')
    return {
      ok: false,
      reason:
        `The stats repo is private and its Pages settings couldn't be read (HTTP ${p.status}). ` +
        'Grant `pages: read` to the job so the action can check whether Pages would make the stats public, ' +
        'or set `allow-public-pages-for-private-repo: true` if that is intended.',
    };
  if (!p.public) return { ok: true };
  if (p.buildType === 'workflow')
    return {
      ok: true,
      warning:
        'This private repo deploys a public Pages site from a workflow. If you deploy the stats site-dir, its contents become public.',
    };
  if (!p.source || p.source.branch === i.branch)
    return {
      ok: false,
      reason:
        `The stats repo is private, but its public GitHub Pages site serves branch \`${i.branch}\`, so publishing would make ` +
        'test names, file paths and failure messages public. Use a branch Pages does not serve, or set ' +
        '`allow-public-pages-for-private-repo: true` if that is intended.',
    };
  return { ok: true };
}
