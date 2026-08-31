import { useEffect, useState } from 'react'

import type * as ChartView from '#/components/chart-view.tsx'

const loadChartView = import.meta.env.SSR
  ? () => Promise.resolve(null)
  : () => import('#/components/chart-view.tsx')

export type ChartViewModule = typeof ChartView

export function useChartView(): ChartViewModule | null {
  const [view, setView] = useState<ChartViewModule | null>(null)

  useEffect(() => {
    let cancelled = false

    void loadChartView().then((module) => {
      if (cancelled || !module) return
      setView(module)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return view
}

const LEGEND_PX = 16 + 8

export function ChartPlaceholder({ height }: { height: number }) {
  return <div aria-hidden style={{ height: height + LEGEND_PX }} />
}
