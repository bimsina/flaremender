/**
 * Short-lived signatures for artifact URLs.
 *
 * The artifact route normally authorises with the session cookie, which is
 * exactly right for a screenshot opened in a tab and exactly wrong for a trace:
 * the Playwright trace viewer is a page on someone else's origin that fetches
 * the zip itself, cross-origin, with no cookies of ours attached. Handing it a
 * URL that carries its own proof is the only way it can read one byte.
 *
 * So a signature stands in for the session: HMAC-SHA256 over `<exp>.<key>`,
 * where the key is the exact object being released and `exp` is when the
 * permission stops. It grants one object for ten minutes and nothing else — no
 * organization, no run, no listing — and it cannot be edited into a different
 * key without the secret.
 *
 * The signing key is derived from `ENCRYPTION_KEY` but is deliberately *not*
 * the encryption key: the digest is taken over `sign:` + the passphrase, so one
 * secret the operator sets yields two unrelated keys and neither purpose can be
 * used as an oracle for the other.
 */
import { readEncryptionKey } from './crypto.ts'

/** Long enough to open a trace, short enough that a leaked URL is worthless. */
export const SIGNATURE_TTL_SECONDS = 600

/** Keyed by the secret, so a rotated passphrase can't reuse the old key. */
const keys = new Map<string, Promise<CryptoKey>>()

function getSigningKey(secret: string): Promise<CryptoKey> {
  const cached = keys.get(secret)
  if (cached) return cached

  const pending = (async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sign:${secret}`))
    return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ])
  })()

  // Don't let one failed import poison the isolate for every later call.
  pending.catch(() => keys.delete(secret))
  keys.set(secret, pending)
  return pending
}

/**
 * What gets signed. The expiry is inside the message, so moving it in the query
 * string invalidates the signature rather than extending the grant.
 */
function payload(key: string, exp: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${exp}.${key}`)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')

  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** @param exp Unix *seconds* at which the grant stops, as it appears in the URL. */
export async function signArtifactKey(key: string, exp: number): Promise<string> {
  const signingKey = await getSigningKey(readEncryptionKey())
  const signature = await crypto.subtle.sign('HMAC', signingKey, payload(key, exp))
  return toBase64Url(new Uint8Array(signature))
}

/**
 * Whether this exact key was released, and is still released.
 *
 * Everything arrives as query-string text, so nothing here trusts its own
 * arguments: a non-numeric expiry, a signature that is not base64url and a
 * signature over a different key all reach the same answer. The comparison
 * itself is `crypto.subtle.verify`, which does not leak by timing.
 */
export async function verifyArtifactSignature(
  key: string,
  exp: string,
  sig: string,
): Promise<boolean> {
  const expires = Number(exp)
  if (!Number.isInteger(expires) || expires <= 0) return false
  if (expires * 1000 <= Date.now()) return false

  const signature = fromBase64Url(sig)
  if (!signature) return false

  const signingKey = await getSigningKey(readEncryptionKey())
  return crypto.subtle.verify('HMAC', signingKey, signature, payload(key, expires))
}
