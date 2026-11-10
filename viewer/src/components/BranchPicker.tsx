import type { IndexEntry } from '../../../src/model.js';
import { branches } from '../lib/runs.js';

/** Branch filter: `''` is every branch. */
export function BranchPicker({
  runs,
  value,
  onChange,
}: {
  runs: IndexEntry[];
  value: string;
  onChange: (branch: string) => void;
}) {
  const names = branches(runs);
  if (names.length < 2 && value === (names[0] ?? '')) return null;
  return (
    <label className="field">
      <span>Branch</span>
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">All branches</option>
        {names.map(b => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
    </label>
  );
}
