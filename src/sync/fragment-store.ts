import type { Fragment, FragmentMap } from '../convert/types';
import type { AppError } from '../util/errors';
import { asNonEmptyString, asString, isRecord } from '../util/guards';
import { sha256 } from '../util/hash';
import { ok, type Result } from '../util/result';
import type { StateGateway } from '../vault/state-gateway';

/**
 * The placeholder fragment cache (spec FR-4.3).
 *
 * A placeholder in a note is only meaningful while the storage-format source
 * behind it is still available: push re-injects that source verbatim, which is
 * what makes preserve-and-reinflate safe (decision D3). The cache lives in the
 * plugin state directory rather than in the note, so a page full of preserved
 * macros stays readable.
 *
 * Every file carries an integrity hash. A fragment set that fails it is treated
 * as absent, so the page is re-pulled — silently pushing a body assembled from
 * fragments that may have been altered is exactly the failure D3 exists to
 * prevent.
 */

interface FragmentFile {
  readonly pageId: string;
  /** sha256 of the storage body these fragments were extracted from. */
  readonly storageHash: string;
  readonly checksum: string;
  readonly fragments: readonly Fragment[];
}

export interface StoredFragments {
  readonly storageHash: string;
  readonly fragments: FragmentMap;
}

/** Canonical form the checksum is taken over. Key order is fixed, so it is stable. */
function canonical(fragments: readonly Fragment[]): string {
  return JSON.stringify(
    fragments.map((fragment) => [
      fragment.id,
      fragment.kind,
      fragment.type,
      fragment.name,
      fragment.label,
      fragment.xhtml,
    ]),
  );
}

function parseFragment(raw: unknown): Fragment | null {
  if (!isRecord(raw)) return null;

  const id = asNonEmptyString(raw['id']);
  const xhtml = asString(raw['xhtml']);
  if (id === null || xhtml === null) return null;

  return {
    id,
    kind: raw['kind'] === 'inline' ? 'inline' : 'block',
    xhtml,
    type: asString(raw['type']) ?? 'unsupported',
    name: asNonEmptyString(raw['name']),
    label: asString(raw['label']) ?? '',
  };
}

/**
 * Page ids come from Confluence, but the settings file they are read back
 * through is user-writable, so they are never interpolated into a path unchecked.
 */
function fileName(pageId: string): string {
  return `fragments/${pageId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

export class FragmentStore {
  constructor(private readonly state: StateGateway) {}

  async save(
    pageId: string,
    storageHash: string,
    fragments: FragmentMap,
  ): Promise<Result<void, AppError>> {
    const list = [...fragments.values()];
    const file: FragmentFile = {
      pageId,
      storageHash,
      checksum: await sha256(canonical(list)),
      fragments: list,
    };
    return this.state.write(fileName(pageId), `${JSON.stringify(file, null, 2)}\n`);
  }

  /** `null` when there is no cache for the page, or it failed its integrity check. */
  async load(pageId: string): Promise<Result<StoredFragments | null, AppError>> {
    const raw = await this.state.read(fileName(pageId));
    if (!raw.ok) return raw;
    if (raw.value === null) return ok(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      return ok(null);
    }
    if (!isRecord(parsed)) return ok(null);

    const list: Fragment[] = [];
    for (const item of Array.isArray(parsed['fragments']) ? parsed['fragments'] : []) {
      const fragment = parseFragment(item);
      if (fragment === null) return ok(null);
      list.push(fragment);
    }

    if ((await sha256(canonical(list))) !== asString(parsed['checksum'])) return ok(null);

    return ok({
      storageHash: asString(parsed['storageHash']) ?? '',
      fragments: new Map(list.map((fragment) => [fragment.id, fragment])),
    });
  }

  async remove(pageId: string): Promise<Result<void, AppError>> {
    return this.state.remove(fileName(pageId));
  }
}
