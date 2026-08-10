/**
 * Macro parameters carried through a Markdown code fence's info string.
 *
 * A Confluence code macro usually has parameters beyond `language` —
 * `linenumbers`, `theme`, `title`, `collapse`. Dropping them would fail
 * certification and make every such page read-only, which for developer
 * documentation means most of them.
 *
 * Encoding them in the fence meta keeps the block readable *and* lossless:
 *
 *     ```java linenumbers="true" theme="Midnight"
 */

export type MacroParams = ReadonlyMap<string, string>;

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Serialises parameters deterministically; key order is sorted so output is stable. */
export function serialiseMacroParams(params: MacroParams): string {
  return Array.from(params.keys())
    .sort()
    .map((key) => `${key}="${escapeValue(params.get(key) ?? '')}"`)
    .join(' ');
}

/**
 * Parses a fence info string's parameters. Anything not matching `key="value"`
 * is ignored rather than guessed at — a user typing free text after the language
 * must not be reinterpreted as macro configuration.
 */
export function parseMacroParams(meta: string | null | undefined): Map<string, string> {
  const params = new Map<string, string>();
  if (meta === null || meta === undefined) return params;

  const pattern = /([A-Za-z_][\w.-]*)="((?:[^"\\]|\\.)*)"/g;
  for (const match of meta.matchAll(pattern)) {
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    params.set(key, raw.replace(/\\(["\\])/g, '$1'));
  }
  return params;
}

/** True when the info string contains nothing but well-formed parameters. */
export function isParamsOnly(meta: string | null | undefined): boolean {
  if (meta === null || meta === undefined) return true;
  const withoutParams = meta.replace(/([A-Za-z_][\w.-]*)="((?:[^"\\]|\\.)*)"/g, '').trim();
  return withoutParams.length === 0;
}
