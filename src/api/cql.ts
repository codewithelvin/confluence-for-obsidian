/**
 * CQL construction (spec §6.2.1).
 *
 * Pure string work, kept apart from the client so the escaping is testable on
 * its own. A space key or page id is server data, but a subscription's root page
 * id arrives from settings, which the user can hand-edit — so nothing is
 * interpolated unquoted.
 */

/**
 * Quotes a CQL literal.
 *
 * Backslash first: escaping the quotes first would then escape the backslashes
 * that escaping introduced, doubling them.
 */
export function quoteCql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Every page in a subscription's scope.
 *
 * With a root page the query includes the root itself as well as its
 * descendants — `ancestor` matches only what is *below* a page, and omitting
 * the root would subscribe to a subtree whose top page never syncs.
 */
export function subtreeCql(spaceKey: string, rootPageId: string | null): string {
  const scope = `space = ${quoteCql(spaceKey)} AND type = page`;
  if (rootPageId === null) return scope;

  const id = quoteCql(rootPageId);
  return `${scope} AND (id = ${id} OR ancestor = ${id})`;
}
