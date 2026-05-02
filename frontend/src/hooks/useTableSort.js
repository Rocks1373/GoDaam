import { useCallback, useMemo, useState } from 'react';

/**
 * Locale-aware comparison: numbers, numeric strings, dates, booleans, text.
 */
export function compareValues(a, b) {
  if (a === b) return 0;
  const aUndef = a === undefined || a === null;
  const bUndef = b === undefined || b === null;
  if (aUndef && bUndef) return 0;
  if (aUndef) return 1;
  if (bUndef) return -1;

  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;

  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return a - b;
  }

  const na = Number(a);
  const nb = Number(b);
  const aNum = String(a).trim() !== '' && !Number.isNaN(na);
  const bNum = String(b).trim() !== '' && !Number.isNaN(nb);
  if (aNum && bNum) return na - nb;

  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Client-side sort. Click same column to toggle asc/desc; new column starts asc.
 *
 * @param {any[]|null|undefined} rows
 * @param {(row: any, key: string) => any} [getSortValue] — optional; default reads row[key]
 */
export function useTableSort(rows, getSortValue) {
  const [sortKey, setSortKey] = useState(null);
  const [direction, setDirection] = useState('asc');

  const defaultGet = useCallback((row, key) => row?.[key], []);

  const displayRows = useMemo(() => {
    const list = Array.isArray(rows) ? [...rows] : [];
    if (!sortKey || !list.length) return list;
    const gv = getSortValue || defaultGet;
    list.sort((ra, rb) => {
      const c = compareValues(gv(ra, sortKey), gv(rb, sortKey));
      return direction === 'asc' ? c : -c;
    });
    return list;
  }, [rows, sortKey, direction, getSortValue, defaultGet]);

  const requestSort = useCallback((key) => {
    setSortKey((prev) => {
      if (prev === key) {
        setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return key;
      }
      setDirection('asc');
      return key;
    });
  }, []);

  return { displayRows, sortKey, direction, requestSort };
}
