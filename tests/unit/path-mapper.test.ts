import { describe, expect, it } from 'vitest';
import {
  buildPathMap,
  mountsOverlap,
  spaceFolderPath,
  type RemotePageNode,
} from '../../src/vault/path-mapper';
import { MAX_ABSOLUTE_PATH } from '../../src/vault/filename-sanitiser';

const OPTIONS = { mountPath: 'Confluence', spaceKey: 'ENG', vaultPathLength: 20 };

function page(id: string, title: string, parentId: string | null = null): RemotePageNode {
  return { id, title, parentId };
}

function pathOf(map: ReturnType<typeof buildPathMap>, id: string): string {
  const mapped = map.byId.get(id);
  if (mapped === undefined) throw new Error(`${id} was not mapped`);
  return mapped.notePath;
}

describe('buildPathMap', () => {
  it('writes a childless page as a single note', () => {
    const map = buildPathMap([page('1', 'API Gateway')], OPTIONS);

    expect(pathOf(map, '1')).toBe('Confluence/ENG/API Gateway.md');
    expect(map.byId.get('1')?.folderPath).toBeNull();
  });

  it('writes a page with children as a folder note (decision D9)', () => {
    const map = buildPathMap([page('1', 'Architecture'), page('2', 'Data Model', '1')], OPTIONS);

    expect(pathOf(map, '1')).toBe('Confluence/ENG/Architecture/Architecture.md');
    expect(map.byId.get('1')?.folderPath).toBe('Confluence/ENG/Architecture');
    expect(pathOf(map, '2')).toBe('Confluence/ENG/Architecture/Data Model.md');
  });

  it('nests to any depth', () => {
    const map = buildPathMap(
      [page('1', 'A'), page('2', 'B', '1'), page('3', 'C', '2'), page('4', 'D', '3')],
      OPTIONS,
    );

    expect(pathOf(map, '4')).toBe('Confluence/ENG/A/B/C/D.md');
  });

  it('treats a page whose parent is outside the subtree as a root', () => {
    // Exactly the shape of a subtree subscription: the root page's own parent
    // exists in Confluence but was never enumerated.
    const map = buildPathMap([page('1', 'Root', '999'), page('2', 'Child', '1')], OPTIONS);

    expect(pathOf(map, '1')).toBe('Confluence/ENG/Root/Root.md');
    expect(pathOf(map, '2')).toBe('Confluence/ENG/Root/Child.md');
  });

  it('separates siblings whose titles sanitise to the same name', () => {
    const map = buildPathMap([page('8061060', 'A/B'), page('8061077', 'A:B')], OPTIONS);

    expect(pathOf(map, '8061060')).toBe('Confluence/ENG/A-B.md');
    expect(pathOf(map, '8061077')).toBe('Confluence/ENG/A-B ~061077.md');
  });

  it('does not let the input order decide which sibling keeps the plain name', () => {
    const pages = [page('8061060', 'A/B'), page('8061077', 'A:B')];
    const forward = buildPathMap(pages, OPTIONS);
    const reversed = buildPathMap([...pages].reverse(), OPTIONS);

    expect(pathOf(reversed, '8061060')).toBe(pathOf(forward, '8061060'));
    expect(pathOf(reversed, '8061077')).toBe(pathOf(forward, '8061077'));
  });

  it('allows the same title in different folders', () => {
    const map = buildPathMap(
      [page('1', 'A'), page('2', 'B'), page('3', 'Notes', '1'), page('4', 'Notes', '2')],
      OPTIONS,
    );

    expect(pathOf(map, '3')).toBe('Confluence/ENG/A/Notes.md');
    expect(pathOf(map, '4')).toBe('Confluence/ENG/B/Notes.md');
  });

  it('truncates a title that would push the path over the Windows budget', () => {
    const map = buildPathMap([page('8061060', 'x'.repeat(400))], OPTIONS);
    const mapped = map.byId.get('8061060');

    expect(mapped?.truncated).toBe(true);
    expect(mapped?.notePath.length).toBeLessThanOrEqual(MAX_ABSOLUTE_PATH - 20);
    expect(mapped?.notePath).toContain('~061060');
  });

  it('charges a folder note for its name twice', () => {
    // The same title is under budget as a leaf and over it as a folder note,
    // because D9 spends the name on both the folder and the file inside it.
    const title = 'y'.repeat(110);
    const leaf = buildPathMap([page('1', title)], OPTIONS);
    const parent = buildPathMap([page('1', title), page('2', 'child', '1')], OPTIONS);

    expect(leaf.byId.get('1')?.truncated).toBe(false);
    expect(parent.byId.get('1')?.truncated).toBe(true);
  });

  it('reports a page it cannot place, and everything under it', () => {
    const map = buildPathMap([page('1', 'Root'), page('2', 'Child', '1')], {
      ...OPTIONS,
      vaultPathLength: MAX_ABSOLUTE_PATH,
    });

    expect(map.byId.size).toBe(0);
    expect(map.unmappable.map((entry) => entry.pageId)).toEqual(['1', '2']);
    expect(map.unmappable[1]?.reason).toContain('parent page');
  });

  it('is deterministic', () => {
    const pages = [page('1', 'A'), page('2', 'B', '1'), page('3', 'C', '1')];
    expect(buildPathMap(pages, OPTIONS).byId).toEqual(buildPathMap(pages, OPTIONS).byId);
  });

  it('reports a cycle in the reported ancestry instead of hanging or dropping it', () => {
    // Confluence should never report one. If it did, these pages have no place
    // in the tree — but they must still appear in the sync report.
    const map = buildPathMap([page('1', 'A', '2'), page('2', 'B', '1')], OPTIONS);

    expect(map.byId.size).toBe(0);
    expect(map.unmappable.map((entry) => entry.pageId).sort()).toEqual(['1', '2']);
  });
});

describe('spaceFolderPath', () => {
  it('places the space under the mount', () => {
    expect(spaceFolderPath('Confluence', 'ENG')).toBe('Confluence/ENG');
  });
});

describe('mountsOverlap', () => {
  it('rejects an identical mount', () => {
    expect(mountsOverlap('Confluence', 'Confluence')).toBe(true);
  });

  it('rejects a mount nested inside another (spec FR-2.5)', () => {
    expect(mountsOverlap('Confluence', 'Confluence/ENG')).toBe(true);
    expect(mountsOverlap('Confluence/ENG', 'Confluence')).toBe(true);
  });

  it('allows siblings', () => {
    expect(mountsOverlap('Confluence/ENG', 'Confluence/OPS')).toBe(false);
  });

  it('does not confuse a shared name prefix with nesting', () => {
    expect(mountsOverlap('Confluence', 'Confluence-archive')).toBe(false);
  });

  it('compares case-insensitively, since Windows does', () => {
    expect(mountsOverlap('Confluence', 'confluence/ENG')).toBe(true);
  });
});
