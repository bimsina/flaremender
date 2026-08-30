export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

/**
 * The part of an id worth showing. Ids are a prefix and twenty characters of
 * entropy, and the tail is the only part anyone compares.
 */
export function shortId(id: string): string {
  return id.slice(-8)
}

/** Turns a display name into a slug; callers must still enforce uniqueness. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
