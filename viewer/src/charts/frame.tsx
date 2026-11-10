import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

/** Width of an element, tracked. Charts draw in real pixels so text and
 *  strokes never stretch. */
export function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    const ro = new ResizeObserver(
      ([e]) => e && setW(e.contentRect.width || fallback),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w] as const;
}

export interface Pad {
  t: number;
  r: number;
  b: number;
  l: number;
}

/**
 * Shared chart shell: one tooltip, driven by the pointer (hover on mouse,
 * tap on touch) and by the arrow keys when focused. `indexAt` maps an x in
 * the plot to a data index. `onOpen` runs on click with a mouse, or on
 * Enter; a touch tap only shows the tooltip, which carries its own link.
 */
export function ChartFrame({
  height,
  pad,
  count,
  label,
  indexAt,
  xOf,
  tooltip,
  onOpen,
  children,
}: {
  height: number;
  pad: Pad;
  count: number;
  label: string;
  indexAt: (x: number, width: number) => number;
  xOf: (i: number, width: number) => number;
  tooltip: (i: number) => ReactNode;
  onOpen?: (i: number) => void;
  children: (width: number, active: number | undefined) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number>();
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (active !== undefined && active >= count) setActive(undefined);
  }, [active, count]);

  // A tapped tooltip stays until the next tap outside the chart.
  useEffect(() => {
    if (!pinned) return;
    const off = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setPinned(false);
        setActive(undefined);
      }
    };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [pinned, ref]);

  const at = (e: PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const x = e.clientX - box.left;
    const i = indexAt(x, width);
    return i >= 0 && i < count ? i : undefined;
  };

  const onKey = (e: KeyboardEvent) => {
    if (!count) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setActive(a =>
        Math.min(count - 1, Math.max(0, (a ?? (d > 0 ? -1 : count)) + d)),
      );
    } else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(count - 1);
    else if (e.key === 'Escape') setActive(undefined);
    else if (e.key === 'Enter' && active !== undefined) onOpen?.(active);
  };

  const tipX = active === undefined ? 0 : xOf(active, width);
  const flip = tipX > width * 0.6;

  return (
    <div
      ref={ref}
      className="chart"
      style={{ height }}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the arrow keys to read each run.`}
      onPointerMove={e => {
        if (e.pointerType === 'mouse') setActive(at(e));
      }}
      onPointerLeave={e => {
        if (e.pointerType === 'mouse' && !pinned) setActive(undefined);
      }}
      onPointerDown={e => {
        const i = at(e);
        if (e.pointerType === 'mouse') {
          if (i !== undefined && onOpen) onOpen(i);
          return;
        }
        setPinned(i !== undefined);
        setActive(i);
      }}
      onKeyDown={onKey}
      onBlur={() => {
        if (!pinned) setActive(undefined);
      }}
    >
      <svg width={width} height={height} aria-hidden="true">
        {children(width, active)}
      </svg>
      {active !== undefined && (
        <div
          className="tooltip"
          role="status"
          style={{
            top: pad.t,
            ...(flip ? { right: width - tipX + 12 } : { left: tipX + 12 }),
          }}
          onPointerDown={e => e.stopPropagation()}
        >
          {tooltip(active)}
        </div>
      )}
    </div>
  );
}

/** "Nice" ticks for a 0-based count axis. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10])
    if (m * p >= v) return m * p;
  return 10 * p;
}

/** Evenly spaced x labels that don't collide: about one per `gap` px. */
export function labelIndexes(count: number, width: number, gap = 90): number[] {
  if (!count) return [];
  const n = Math.max(1, Math.min(count, Math.floor(width / gap)));
  if (n === 1) return [count - 1];
  const out = new Set<number>();
  for (let k = 0; k < n; k++) out.add(Math.round((k * (count - 1)) / (n - 1)));
  return [...out];
}
