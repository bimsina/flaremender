/** Use a distinct sign: derivation prefix so signing and encryption do not share a key. */
import { readEncryptionKey } from '#/server/core/crypto.ts'

export const SIGNATURE_TTL_SECONDS = 600

/** Key the cache by the secret so rotation cannot reuse an old signing key. */
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

  pending.catch(() => keys.delete(secret))
  keys.set(secret, pending)
  return pending
}

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

export async function signArtifactKey(key: string, exp: number): Promise<string> {
  const signingKey = await getSigningKey(readEncryptionKey())
  const signature = await crypto.subtle.sign('HMAC', signingKey, payload(key, exp))
  return toBase64Url(new Uint8Array(signature))
}

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
