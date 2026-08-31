import { Button } from '@cloudflare/kumo'
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

export function ScrollableTabs({ children }: { children: React.ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const element = container.current
    if (!element) return
    const update = () =>
      setEdges({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    element.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', update)
    }
  }, [])
  return (
    <div className="relative min-w-0 max-w-full">
      <div ref={container} className="project-tabs min-w-0 max-w-full overflow-x-auto pb-1">
        {children}
      </div>
      {edges.left ? (
        <div className="absolute inset-y-0 left-0 flex items-center bg-kumo-canvas pr-1">
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            aria-label="Scroll tabs left"
            onClick={() => container.current?.scrollBy({ left: -180, behavior: 'smooth' })}
          >
            <CaretLeftIcon size={16} />
          </Button>
        </div>
      ) : null}
      {edges.right ? (
        <div className="absolute inset-y-0 right-0 flex items-center bg-kumo-canvas pl-1">
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            aria-label="Scroll tabs right"
            onClick={() => container.current?.scrollBy({ left: 180, behavior: 'smooth' })}
          >
            <CaretRightIcon size={16} />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
