export function devOnly(): Response | null {
  return import.meta.env.PROD ? new Response('Not found', { status: 404 }) : null
}
