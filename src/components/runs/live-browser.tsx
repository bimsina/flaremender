import { Loader, Text, cn } from '@cloudflare/kumo'
import { GlobeIcon } from '@phosphor-icons/react'

import { RelativeTime } from '#/components/ui/relative-time.tsx'
import type { LiveFrame } from '#/lib/hooks/use-channel-feed.ts'

/**
 * What the agent's browser is showing right now. Frames arrive over the run channel
 * as small JPEGs; the newest one is painted inside a browser-shaped frame so it reads
 * as a window, not a screenshot in a list.
 */
export function LiveBrowser({
  frame,
  active,
  caption,
  size = 'base',
}: {
  frame: LiveFrame | null
  /** Whether more frames are expected. Shows a pulse while true. */
  active: boolean
  caption?: string | null
  size?: 'sm' | 'base'
}) {
  const aspect = frame ? `${frame.width} / ${frame.height}` : '16 / 9'

  return (
    <figure className="grid gap-1.5">
      <div className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-recessed">
        <div className="flex items-center gap-2 border-b border-kumo-hairline px-2.5 py-1.5">
          <span className="flex gap-1">
            <span className="size-2 rounded-full bg-kumo-inactive/60" />
            <span className="size-2 rounded-full bg-kumo-inactive/60" />
            <span className="size-2 rounded-full bg-kumo-inactive/60" />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-kumo-elevated px-2 py-0.5">
            <GlobeIcon size={12} className="shrink-0 text-kumo-subtle" />
            <Text as="span" variant="secondary" size="base" truncate>
              {caption ?? (active ? 'The agent is driving this browser' : 'Browser')}
            </Text>
          </span>
          {active ? (
            <span className="flex items-center gap-1.5">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-kumo-success opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-kumo-success" />
              </span>
              <Text as="span" variant="secondary" size="base">
                Live
              </Text>
            </span>
          ) : null}
        </div>
        <div
          className={cn('relative w-full bg-white', !frame && 'flex items-center justify-center')}
          style={{ aspectRatio: aspect, maxHeight: size === 'sm' ? '18rem' : '32rem' }}
        >
          {frame ? (
            <img
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt="The page the agent's browser is showing"
              className="absolute inset-0 size-full object-contain"
            />
          ) : (
            <span className="flex items-center gap-2 text-kumo-subtle">
              {active ? <Loader size="sm" /> : null}
              <Text as="span" variant="secondary" size="base">
                {active ? 'Opening the browser…' : 'No frame was captured.'}
              </Text>
            </span>
          )}
        </div>
      </div>
      {frame ? (
        <figcaption>
          <Text as="span" variant="secondary" size="base">
            Frame captured <RelativeTime value={frame.at} />
          </Text>
        </figcaption>
      ) : null}
    </figure>
  )
}
