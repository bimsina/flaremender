import { useEffect, useState } from 'react'

import type * as ChartView from '#/components/chart-view.tsx'

/**
 * The seam between the app and ECharts.
 *
 * Written as a folded ternary rather than an `if` inside the effect so that the
 * SSR build — where Vite substitutes `true` for `import.meta.env.SSR` — drops
 * the `import()` during tree-shaking. Without that the megabyte of ECharts is
 * emitted into the Worker bundle even though the server never draws a pixel of
 * it. `code-editor.tsx` loads CodeMirror the same way.
 */
const loadChartView = import.meta.env.SSR
  ? () => Promise.resolve(null)
  : () => import('#/components/chart-view.tsx')

export type ChartViewModule = typeof ChartView

/**
 * The chart components, once the browser has them; `null` on the server and
 * until the chunk lands. Callers render a box of the final height in the
 * meantime, so the page it arrives into does not move.
 */
export function useChartView(): ChartViewModule | null {
  const [view, setView] = useState<ChartViewModule | null>(null)

  useEffect(() => {
    let cancelled = false

    void loadChartView().then((module) => {
      // The import is a round trip; the tab holding it can close first.
      if (cancelled || !module) return
      setView(module)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return view
}

/**
 * The height of the legend row under every chart here: `ChartLegend.SmallItem`
 * is a fixed `h-4`, sitting a `gap-2` below the canvas.
 */
const LEGEND_PX = 16 + 8

/** Holds the exact space the chart will take, so nothing shifts when it lands. */
export function ChartPlaceholder({ height }: { height: number }) {
  return <div aria-hidden style={{ height: height + LEGEND_PX }} />
}
