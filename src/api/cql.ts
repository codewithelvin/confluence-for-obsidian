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

/**
 * How far before the last sync the comment query reaches back (§16 O16).
 *
 * CQL dates are interpreted in the **server's** timezone, and the plugin has no
 * reliable way to learn what that is. An instance west of UTC would therefore be
 * asked for a moment later than intended and would omit comments the sync should
 * have seen. Reaching back further than any offset can account for turns that silent
 * omission into a slightly larger result set, which the caller then filters exactly
 * by each comment's own absolute timestamp — so the margin costs one bigger *search*,
 * never a page fetch.
 */
export const COMMENT_WINDOW_HOURS = 24;

/** A CQL date-time (`yyyy-MM-dd HH:mm`), reached back by the given hours. */
export function cqlDateTime(iso: string, marginHours: number): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;

  return new Date(at - marginHours * 3_600_000)
    .toISOString()
    .slice(0, 'yyyy-MM-ddTHH:mm'.length)
    .replace('T', ' ');
}

/**
 * Comments in a space that have moved since a moment in time (§16 O16).
 *
 * The whole point of the query is that it is *one request per subscription*: a
 * colleague commenting without editing changes nothing a version-based sync looks at,
 * and asking each of a space's 1 469 pages for its comments is out of the question
 * against §7.1. Scoped by space rather than by `ancestor`, because a comment's
 * ancestry is its page's and relying on that for a subtree subscription is an
 * assumption this project has not verified; the caller intersects the answer with the
 * pages it already knows are in scope.
 */
export function commentsChangedCql(spaceKey: string, since: string): string {
  return `space = ${quoteCql(spaceKey)} AND type = comment AND lastModified >= ${quoteCql(since)}`;
}
