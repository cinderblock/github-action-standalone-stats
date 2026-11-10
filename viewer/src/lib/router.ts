/// <reference lib="dom" />
/**
 * Hash routing (Pages has no rewrites): `#/runs/<key>?a=b`. Path segments
 * are URI-encoded individually, so test ids and file paths survive.
 */
import { useSyncExternalStore } from 'react';

export interface Route {
  parts: string[];
  query: URLSearchParams;
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const parts = path
    .split('/')
    .filter(Boolean)
    .map(s => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { parts, query: new URLSearchParams(q < 0 ? '' : raw.slice(q + 1)) };
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parse(hash);
}

/** Build a hash href from path segments and optional query values (empty
 *  and undefined values are dropped). A segment may contain `/`; it's
 *  split, so file paths stay readable in the URL. */
export function href(
  parts: (string | number)[],
  query: Record<string, string | undefined> = {},
): string {
  const path = parts
    .flatMap(p => String(p).split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  const qs = q.toString();
  return `#/${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
