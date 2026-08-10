/**
 * Runtime type guards for untrusted input.
 *
 * Two sources of untrusted data feed this plugin: `data.json` (user-writable,
 * survives downgrades) and Confluence API responses (a 200 is not a type
 * guarantee — spec §7.2). Both go through these.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Reads a nested property by path, e.g. `readPath(res, '_links', 'next')`.
 * Returns `undefined` as soon as any segment is missing or not an object.
 */
export function readPath(source: unknown, ...path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}
