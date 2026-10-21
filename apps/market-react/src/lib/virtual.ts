/**
 * Windowing math for a responsive grid, kept pure so it is tested without a layout engine.
 *
 * The grid is a list of rows. Rows have their own heights (a card with a "Buy" button is taller than
 * one without), measured once rendered and estimated before that, so offsets are a prefix sum.
 */

/** As many columns as fit, like `repeat(auto-fill, minmax(min, 1fr))`. */
export function columnsFor(width: number, minColumnWidth: number, gap: number): number {
  if (width <= 0) return 1
  return Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
}

/** `offsets[i]` = top of row i; `offsets[rows]` = total height (no trailing gap). */
export function rowOffsets(rows: number, heightOf: (row: number) => number, gap: number): Float64Array {
  const offsets = new Float64Array(rows + 1)
  for (let row = 0; row < rows; row++) offsets[row + 1] = offsets[row]! + heightOf(row) + (row < rows - 1 ? gap : 0)
  return offsets
}

/**
 * Rows intersecting [top, bottom] (px from the grid's top), widened by `overscan` rows each side.
 * Binary search: O(log n) per scroll event, whatever the collection size.
 */
export function visibleRows(offsets: Float64Array, top: number, bottom: number, overscan: number): { start: number; end: number } {
  const rows = offsets.length - 1
  if (rows <= 0 || bottom < 0 || top > offsets[rows]!) return { start: 0, end: 0 }
  // First row whose bottom edge is below `top`.
  let lo = 0
  let hi = rows - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1]! <= top) lo = mid + 1
    else hi = mid
  }
  let end = lo
  while (end < rows && offsets[end]! < bottom) end++
  return { start: Math.max(0, lo - overscan), end: Math.min(rows, Math.max(end, lo + 1) + overscan) }
}
