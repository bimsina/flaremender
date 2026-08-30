import { DurableObject } from 'cloudflare:workers'

/**
 * Per-run fan-out channel.
 *
 * A placeholder for now: it exists so the `v1` SQLite migration has a class to
 * point at and so the binding resolves. Live run streaming lands later.
 */
export class RunChannel extends DurableObject<Cloudflare.Env> {
  ping(): string {
    return 'pong'
  }
}
