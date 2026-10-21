import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefCallback } from 'react'
import { columnsFor, rowOffsets, visibleRows } from '../lib/virtual'

const GAP = 16
const MIN_COLUMN = 180
const ESTIMATED_ROW = 300
const OVERSCAN_ROWS = 2
/** Below this a plain grid is cheaper and keeps find-in-page working for every card. */
const VIRTUALIZE_FROM = 60

/**
 * The token grid. Large collections render only the rows near the viewport: a wallet holding 10 000
 * NFTs costs a few dozen cards of DOM, not 10 000. The page itself scrolls (no inner scroll box), so
 * it works the same standalone and inside the shell. Row heights are measured as rows render.
 */
export function VirtualGrid<T>({
  items,
  getKey,
  renderItem,
}: {
  items: readonly T[]
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
}) {
  if (items.length < VIRTUALIZE_FROM) {
    return <div className="tokens">{items.map((item) => <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>)}</div>
  }
  return <Windowed items={items} getKey={getKey} renderItem={renderItem} />
}

function Windowed<T>({ items, getKey, renderItem }: { items: readonly T[]; getKey: (item: T) => string; renderItem: (item: T) => ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [range, setRange] = useState({ top: 0, bottom: typeof window === 'undefined' ? 1000 : window.innerHeight })
  // Measured heights by row index; a version bump re-renders after new measurements.
  const heights = useRef(new Map<number, number>())
  const [, setMeasured] = useState(0)

  const columns = columnsFor(width, MIN_COLUMN, GAP)
  const rows = Math.ceil(items.length / columns)
  // Heights are per row index, so they are stale once the column count changes.
  const lastColumns = useRef(columns)
  const rowRefs = useRef(new Map<number, RefCallback<HTMLDivElement>>())
  if (lastColumns.current !== columns) {
    heights.current.clear()
    rowRefs.current.clear()
    lastColumns.current = columns
  }
  // Unmeasured rows are assumed to look like the measured ones.
  const estimate = averageOf(heights.current) ?? ESTIMATED_ROW
  const offsets = rowOffsets(rows, (row) => heights.current.get(row) ?? estimate, GAP)
  const { start, end } = visibleRows(offsets, range.top, range.bottom, OVERSCAN_ROWS)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const resize = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    resize.observe(element)

    let frame = 0
    const update = () => {
      frame = 0
      const top = -element.getBoundingClientRect().top
      setRange((r) => (r.top === top && r.bottom === top + window.innerHeight ? r : { top, bottom: top + window.innerHeight }))
    }
    const schedule = () => {
      frame ||= requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      resize.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  /** One stable ref per row (React 19 ref cleanup), so a re-render doesn't re-create its observer. */
  const measure = (row: number): RefCallback<HTMLDivElement> => {
    let ref = rowRefs.current.get(row)
    if (!ref) {
      ref = (element) => {
        if (!element) return
        const observer = new ResizeObserver(([entry]) => {
          const height = entry!.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight
          if (height > 0 && Math.abs((heights.current.get(row) ?? 0) - height) > 0.5) {
            heights.current.set(row, height)
            setMeasured((v) => v + 1)
          }
        })
        observer.observe(element)
        return () => observer.disconnect()
      }
      rowRefs.current.set(row, ref)
    }
    return ref
  }

  const rendered: ReactNode[] = []
  for (let row = start; row < end; row++) {
    const slice = items.slice(row * columns, (row + 1) * columns)
    rendered.push(
      <div
        key={`${columns}:${row}`}
        ref={measure(row)}
        className="tokens tokens-row"
        style={{ transform: `translateY(${offsets[row]}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {slice.map((item) => (
          <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>
        ))}
      </div>,
    )
  }

  return (
    <div ref={container} className="tokens-window" style={{ height: offsets[rows] }} aria-rowcount={rows} data-rendered-rows={end - start}>
      {rendered}
    </div>
  )
}

function averageOf(values: Map<number, number>): number | undefined {
  if (values.size === 0) return undefined
  let sum = 0
  for (const value of values.values()) sum += value
  return sum / values.size
}
