import { DurableObject } from 'cloudflare:workers'

import type { RunChannelSink, RunEvent, RunEventEnvelope } from '#/engine/contract.ts'

const EVENT_PREFIX = 'evt:'
const SEQ_KEY = 'seq'

const SEQ_DIGITS = 12

const MAX_BUFFERED = 1000

const CLEANUP_DELAY_MS = 15 * 60 * 1000

const ABANDONED_DELAY_MS = 60 * 60 * 1000

function eventKey(seq: number): string {
  return `${EVENT_PREFIX}${String(seq).padStart(SEQ_DIGITS, '0')}`
}

export class RunChannel extends DurableObject<Cloudflare.Env> implements RunChannelSink {
  #seq: number | null = null

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)

    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async push(event: RunEvent): Promise<void> {
    const seq = await this.#nextSeq()
    const envelope: RunEventEnvelope = { seq, event }

    await this.ctx.storage.put(
      seq <= MAX_BUFFERED ? { [SEQ_KEY]: seq, [eventKey(seq)]: envelope } : { [SEQ_KEY]: seq },
    )

    if (seq === 1 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ABANDONED_DELAY_MS)
    }

    this.#broadcast(envelope)
  }

  async finish(event: RunEvent): Promise<void> {
    await this.push(event)
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS)
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.#seq = null

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, 'Run channel closed.')
      } catch {}
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.ctx.acceptWebSocket(server)

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

  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1006 ? 1000 : code, reason)
    } catch {}
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'Socket error.')
    } catch {}
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
      } catch {}
    }
  }
}
