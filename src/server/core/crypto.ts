import { env } from 'cloudflare:workers'

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

const ENVELOPE_VERSION = 'v1'
const IV_BYTES = 12

/** Key the cached promise by the secret so rotation cannot reuse an old CryptoKey. */
const keys = new Map<string, Promise<CryptoKey>>()

export function readEncryptionKey(): string {
  const secret = env.ENCRYPTION_KEY
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new CryptoError(
      'ENCRYPTION_KEY is not set. Add it to .env.local for local development, or set it as a Worker secret (`wrangler secret put ENCRYPTION_KEY`) before storing credentials.',
    )
  }
  return secret
}

function getKey(secret: string): Promise<CryptoKey> {
  const cached = keys.get(secret)
  if (cached) return cached

  const pending = (async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
  })()

  pending.catch(() => keys.delete(secret))
  keys.set(secret, pending)
  return pending
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new CryptoError('Stored secret is not valid base64.')
  }

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey(readEncryptionKey())
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )

  return [ENVELOPE_VERSION, toBase64(iv), toBase64(new Uint8Array(ciphertext))].join('.')
}

export async function decryptSecret(envelope: string): Promise<string> {
  const parts = envelope.split('.')
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    throw new CryptoError('Stored secret is not in a recognised format.')
  }

  const key = await getKey(readEncryptionKey())
  const iv = fromBase64(parts[1]!)
  const ciphertext = fromBase64(parts[2]!)

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  } catch {
    throw new CryptoError(
      'Could not decrypt a stored secret. ENCRYPTION_KEY has probably changed since it was saved — re-enter the value.',
    )
  }

  return new TextDecoder().decode(plaintext)
}

export function maskSecret(value: string): string {
  const dots = '••••'
  return value.length <= 4 ? dots : `${dots}${value.slice(-4)}`
}
