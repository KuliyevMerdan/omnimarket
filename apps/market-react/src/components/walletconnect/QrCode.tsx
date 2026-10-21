import { useMemo } from 'react'
import { encode } from 'uqr'

/**
 * The QR matrix drawn as one SVG path (no `innerHTML`, no canvas). Always dark-on-white with a
 * quiet zone: inverted or low-contrast codes fail on many phone cameras, whatever the page theme.
 */
export function QrCode({ value, size = 240, label }: { value: string; size?: number; label: string }) {
  const { path, modules } = useMemo(() => {
    const { data, size: modules } = encode(value, { ecc: 'M', border: 2 })
    let path = ''
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`
      }),
    )
    return { path, modules }
  }, [value])

  return (
    <svg className="qr" viewBox={`0 0 ${modules} ${modules}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
