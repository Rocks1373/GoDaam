/**
 * Clickable table header for client-side sort (pair with useTableSort).
 * Omit for non-sortable columns (e.g. Actions).
 * Use bare=true when not using .tbl-th (e.g. dense report grids); pass full cell classes in className.
 */
export default function SortTh({
  columnKey,
  sortKey,
  direction,
  onSort,
  children,
  className = '',
  bare = false,
  style,
  /** When true, render a div (for use inside a parent &lt;th&gt; with resize handles). */
  asDiv = false,
}) {
  const active = sortKey === columnKey;
  const base = bare
    ? 'cursor-pointer select-none hover:bg-gray-100'
    : 'tbl-th cursor-pointer select-none hover:bg-gray-100';
  const Tag = asDiv ? 'div' : 'th';
  return (
    <Tag
      scope={asDiv ? undefined : 'col'}
      role="columnheader"
      style={style}
      className={`${base} ${className}`.trim()}
      onClick={() => onSort(columnKey)}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[9px] tabular-nums opacity-60" title={active ? `Sorted ${direction}` : 'Sort'}>
          {active ? (direction === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </span>
    </Tag>
  );
}
