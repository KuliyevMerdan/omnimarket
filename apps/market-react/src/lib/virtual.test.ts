import { describe, expect, it } from 'vitest'
import { columnsFor, rowOffsets, visibleRows } from './virtual'

describe('virtual grid math', () => {
  it('fits columns like auto-fill', () => {
    expect(columnsFor(0, 180, 16)).toBe(1)
    expect(columnsFor(179, 180, 16)).toBe(1)
    expect(columnsFor(376, 180, 16)).toBe(2)
    expect(columnsFor(375, 180, 16)).toBe(1)
    expect(columnsFor(1200, 180, 16)).toBe(6)
  })

  it('stacks rows of different heights with gaps between them only', () => {
    const offsets = rowOffsets(3, (row) => [100, 150, 120][row]!, 10)
    expect([...offsets]).toEqual([0, 110, 270, 390])
  })

  it('finds the rows in view with a binary search, plus overscan', () => {
    // 10 000 rows of 100 px + 10 px gap.
    const offsets = rowOffsets(10_000, () => 100, 10)
    expect(visibleRows(offsets, 0, 500, 0)).toEqual({ start: 0, end: 5 })
    expect(visibleRows(offsets, 109, 110, 0)).toEqual({ start: 0, end: 1 })
    expect(visibleRows(offsets, 110, 220, 0)).toEqual({ start: 1, end: 2 })
    expect(visibleRows(offsets, 550_000, 551_000, 2)).toEqual({ start: 4998, end: 5012 })
    // Scrolled above or below the grid: nothing to render.
    expect(visibleRows(offsets, -2000, -1000, 2)).toEqual({ start: 0, end: 0 })
    expect(visibleRows(offsets, 2_000_000, 2_001_000, 2)).toEqual({ start: 0, end: 0 })
    expect(visibleRows(rowOffsets(0, () => 0, 0), 0, 100, 2)).toEqual({ start: 0, end: 0 })
  })
})
