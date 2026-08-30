/**
 * The spike routes are unauthenticated on purpose — they exist to prove the
 * Cloudflare integrations under local dev. This keeps them inert anywhere else.
 */
export function devOnly(): Response | null {
  return import.meta.env.PROD ? new Response('Not found', { status: 404 }) : null
}
