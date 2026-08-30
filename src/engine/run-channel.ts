/**
 * Per-run fan-out channel.
 *
 * One Durable Object per run, addressed by the run id, sitting between the two
 * halves of a live run: the producers (the Workflow, and the harness inside the
 * Dynamic Worker) call `push` over RPC, and every browser watching the run holds
 * a WebSocket that the same object broadcasts to.
 *
 * Two properties make this worth an object rather than a pub/sub topic:
 *
 * - **Every event is kept until the run is old.** A page opened halfway through
 *   a run — or a minute after it finished — replays the whole thing on connect,
 *   so "did I connect in time" is never a question the UI has to answer.
 * - **Sockets hibernate.** They are accepted with `ctx.acceptWebSocket`, so a
 *   long-running script does not hold an instance in memory between steps; the
 *   object wakes only when there is something to say.
 *
 * The channel deliberately does no scrubbing. Step events are redacted inside
 * the harness, which is the only isolate where the plaintext secrets exist;
 * anything that arrives here is already safe to store and to broadcast.
 */
import { DurableObject } from 'cloudflare:workers'

import type { RunChannelSink, RunEvent, RunEventEnvelope } from '#/engine/contract.ts'

/** Events live under this prefix; the sequence counter deliberately does not. */
const EVENT_PREFIX = 'evt:'
const SEQ_KEY = 'seq'

/** Wide enough that lexicographic key order is numeric order for any real run. */
const SEQ_DIGITS = 12

/**
 * How many events a run may leave behind for a late viewer. Past this the
 * channel keeps broadcasting but stops buffering — a run that produced a
 * thousand steps is not one anybody reads from the top.
 */
const MAX_BUFFERED = 1000

/** How long a finished run stays replayable. */
const CLEANUP_DELAY_MS = 15 * 60 * 1000

/**
 * The backstop for a run that never reports finishing — a Workflow instance
 * killed mid-step leaves no `finish` call behind, and without this its events
 * would sit in storage for ever.
 */
const ABANDONED_DELAY_MS = 60 * 60 * 1000

function eventKey(seq: number): string {
  return `${EVENT_PREFIX}${String(seq).padStart(SEQ_DIGITS, '0')}`
}

export class RunChannel extends DurableObject<Cloudflare.Env> implements RunChannelSink {
  /**
   * Cached across calls but never trusted across a hibernation: the counter is
   * persisted too, and re-read the first time an evicted instance is woken.
   */
  #seq: number | null = null

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)

    // Answered by the runtime without waking the object, which is the whole
    // point of a keepalive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /**
   * Records an event and tells everyone watching.
   *
   * Storage first, broadcast second: a socket that connects between the two
   * replays the event from storage rather than missing it, and the input gate
   * makes the pair atomic with respect to `fetch`.
   */
  async push(event: RunEvent): Promise<void> {
    const seq = await this.#nextSeq()
    const envelope: RunEventEnvelope = { seq, event }

    await this.ctx.storage.put(
      seq <= MAX_BUFFERED ? { [SEQ_KEY]: seq, [eventKey(seq)]: envelope } : { [SEQ_KEY]: seq },
    )

    // Only the very first event of a run reaches for the alarm API; after that
    // one is already pending and `finish` is what moves it.
    if (seq === 1 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ABANDONED_DELAY_MS)
    }

    this.#broadcast(envelope)
  }

  /**
   * The last event of a run, plus the countdown to forgetting it.
   *
   * Sockets are left open: the client decides when it has what it needs, and a
   * page that reconnects inside the window still gets the full replay.
   */
  async finish(event: RunEvent): Promise<void> {
    await this.push(event)
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS)
  }

  /** The run is old enough that nobody is coming back for it. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.#seq = null

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, 'Run channel closed.')
      } catch {
        // Already gone; nothing to close.
      }
    }
  }

  /**
   * The WebSocket upgrade, reached only through `src/server.ts` — which has
   * already established that the caller is signed in and that the run belongs to
   * their organization. Nothing here re-checks that, so nothing else may route
   * to this object.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    // Hibernation, not `server.accept()`: the runtime holds the socket while the
    // object sleeps between steps.
    this.ctx.acceptWebSocket(server)

    // Storage reads keep the input gate closed, so no `push` can interleave with
    // the replay — the new socket sees every event exactly once, in order.
    const buffered = await this.ctx.storage.list<RunEventEnvelope>({ prefix: EVENT_PREFIX })
    for (const envelope of buffered.values()) {
      try {
        server.send(JSON.stringify(envelope))
      } catch {
        break
      }
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * The channel is one-way. Anything a client sends is ignored — `ping` never
   * reaches here at all, since the runtime answers it.
   */
  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // 1006 is "no close frame", which a client cannot send back.
    try {
      ws.close(code === 1006 ? 1000 : code, reason)
    } catch {
      // Already closed.
    }
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'Socket error.')
    } catch {
      // Already closed.
    }
  }

  async #nextSeq(): Promise<number> {
    if (this.#seq === null) {
      this.#seq = (await this.ctx.storage.get<number>(SEQ_KEY)) ?? 0
    }

    this.#seq += 1
    return this.#seq
  }

  #broadcast(envelope: RunEventEnvelope): void {
    const payload = JSON.stringify(envelope)

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload)
      } catch {
        // A socket that died between `getWebSockets()` and here is not this
        // object's problem — the close handler will tidy it up.
      }
    }
  }
}
