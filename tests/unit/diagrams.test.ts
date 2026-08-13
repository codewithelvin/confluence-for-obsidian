import { describe, expect, it } from 'vitest';
import { referencedAttachments } from '../../src/convert/attachments';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { diagramCandidates } from '../../src/convert/storage-drawio';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Diagram macros shown as diagrams (spec §6.4.8, D17, FR-4.13, FR-8.8).
 *
 * The shapes here are the ones space EP actually holds: three diagrams alone on a
 * page (`Act signing process`, page 36013439, where the macros are the whole
 * content), and two inside a paragraph of prose.
 */

const MOUNT = 'EP/_attachments/36013439';

const DOWNLOADED = new Map([
  ['Cancel.png', `${MOUNT}/Cancel.png`],
  ['Sign with blank.png', `${MOUNT}/Sign with blank.png`],
  ['Old2PO.drawio.png', `${MOUNT}/Old2PO.drawio.png`],
]);

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
  resolveAttachment: (filename: string): string | null => DOWNLOADED.get(filename) ?? null,
  attachmentFor: (path: string): string | null => {
    for (const [filename, candidate] of DOWNLOADED) {
      if (candidate === path) return filename;
    }
    return null;
  },
};

/** The macro exactly as page 36013439 stores it, parameters and all. */
function drawio(diagramName: string, revision = '5'): string {
  return (
    '<ac:structured-macro ac:name="drawio" ac:schema-version="1" ac:macro-id="ed8bf1ac">' +
    '<ac:parameter ac:name="border">true</ac:parameter>' +
    `<ac:parameter ac:name="diagramName">${diagramName}</ac:parameter>` +
    '<ac:parameter ac:name="simpleViewer">false</ac:parameter>' +
    '<ac:parameter ac:name="width"/>' +
    '<ac:parameter ac:name="links">auto</ac:parameter>' +
    '<ac:parameter ac:name="tbstyle">top</ac:parameter>' +
    '<ac:parameter ac:name="lbox">true</ac:parameter>' +
    '<ac:parameter ac:name="diagramWidth">581</ac:parameter>' +
    `<ac:parameter ac:name="revision">${revision}</ac:parameter>` +
    '</ac:structured-macro>'
  );
}

function convert(storage: string, options: ConversionOptions = OPTIONS): string {
  const result = storageToMarkdown(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

/** What a push would send for a note the user has edited. */
function push(markdown: string, storage: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(markdown, forward.value.fragments, OPTIONS);
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

describe('a diagram macro at body level', () => {
  it('becomes the embed of its preview, with the macro carried beside it', () => {
    expect(convert(drawio('Cancel'))).toBe(`![[${MOUNT}/Cancel.png]]<!--cf-drawio:cfb-0001-->`);
  });

  it('hands Confluence back the identical macro, so the page stays certified', () => {
    expect(certified(drawio('Cancel'))).toBe(true);
  });

  it('replaces the paragraph rather than being wrapped in one', () => {
    // The macro was a child of the body. A `<p>` around it on the way back is
    // markup Confluence never sent, and would make the page read-only.
    const markdown = convert(drawio('Cancel'));

    expect(push(markdown, drawio('Cancel'))).toBe(drawio('Cancel'));
  });

  it('shows a diagram whose name contains spaces', () => {
    // `Sign with blank` is real: two of the three diagrams on page 36013439 have
    // spaces in their names, and a space is safe in a wikilink.
    expect(convert(drawio('Sign with blank'))).toContain(`![[${MOUNT}/Sign with blank.png]]`);
    expect(certified(drawio('Sign with blank'))).toBe(true);
  });

  it('takes the second candidate when the preview is named for the app instead', () => {
    expect(convert(drawio('Old2PO'))).toContain(`![[${MOUNT}/Old2PO.drawio.png]]`);
  });
});

describe('a diagram inside a paragraph', () => {
  it('uses the inline carrier, because there the wrapping paragraph is Confluence own', () => {
    const inline = `<p>See ${drawio('Cancel')} for the flow.</p>`;

    expect(convert(inline)).toBe(
      `See ![[${MOUNT}/Cancel.png]]<!--cf-img:cfb-0001--> for the flow.`,
    );
    expect(certified(inline)).toBe(true);
  });
});

describe('a diagram with no preview on disk', () => {
  const missing = drawio('Untitled Diagram');

  it('stays a placeholder rather than showing a broken embed', () => {
    expect(convert(missing)).toContain('```confluence-block');
    expect(convert(missing)).not.toContain('![[');
  });

  it('is labelled with the diagram it stands for, not with its parameter values', () => {
    // What this used to read: `drawio macro — trueCancelfalseautotoptrue5815`.
    expect(convert(missing)).toContain('label: drawio macro — Untitled Diagram');
  });

  it('still round-trips exactly', () => {
    expect(certified(missing)).toBe(true);
  });

  it('stays one when the preview is on disk under a path no wikilink can hold', () => {
    // `#` addresses a heading inside a wikilink, so an embed built on it would
    // point at nothing. The label is the honest answer.
    const unlinkable: ConversionOptions = {
      ...OPTIONS,
      resolveAttachment: (): string | null => `${MOUNT}/Cancel#1.png`,
    };

    expect(convert(drawio('Cancel'), unlinkable)).toContain('```confluence-block');
  });
});

describe('an edit to a note holding a diagram', () => {
  it('keeps the diagram when the user deletes the picture and leaves the marker', () => {
    // The same reading as a carried image: an edit that only looked like a
    // deletion must not silently drop the macro from the page.
    expect(push('<!--cf-drawio:cfb-0001-->', drawio('Cancel'))).toBe(drawio('Cancel'));
  });

  it('does not inflate the macro over text the user typed in its place', () => {
    const typed = 'Replaced the diagram.<!--cf-drawio:cfb-0001-->';
    const sent = push(typed, drawio('Cancel'));

    // The words survive, and the unread marker rides into the storage where push
    // verification stops the page — better than deleting what they wrote.
    expect(sent).toContain('Replaced the diagram.');
    expect(sent).not.toContain('ac:name="drawio"');
  });
});

describe('finding the preview to download (FR-8.8)', () => {
  it('names the candidates a diagram might be stored under', () => {
    expect(diagramCandidates('Cancel')).toEqual(['Cancel.png', 'Cancel.drawio.png', 'Cancel']);
  });

  it('names nothing for a macro with no diagram name', () => {
    expect(diagramCandidates('   ')).toEqual([]);
  });

  it('asks for the untrimmed name too, where the two differ', () => {
    // Page 98074876's diagram is named `XRMV ` with a trailing space, and the app names
    // the preview after the name as given — so trimming first asks only for a file that
    // was never created, and the diagram stays a widget beside a preview on the page.
    expect(diagramCandidates('XRMV ')).toEqual([
      'XRMV.png',
      'XRMV.drawio.png',
      'XRMV',
      'XRMV .png',
      'XRMV .drawio.png',
      'XRMV ',
    ]);
  });

  it('puts them in the referenced set, so a diagram-only page is still listed', () => {
    // Without this the page is skipped before its attachments are ever listed,
    // and FR-4.13 has nothing on disk to embed.
    expect([...referencedAttachments(drawio('Cancel')).all]).toEqual([
      'Cancel.png',
      'Cancel.drawio.png',
      'Cancel',
    ]);
  });

  it('still finds an ordinary ri:filename alongside a diagram', () => {
    const both = `<p><ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>${drawio('D')}`;

    expect([...referencedAttachments(both).all].sort()).toEqual([
      'D',
      'D.drawio.png',
      'D.png',
      'a.png',
    ]);
  });
});

describe('a placeholder label (FR-4.14)', () => {
  function labelOf(storage: string): string {
    const line = convert(storage)
      .split('\n')
      .find((candidate) => candidate.startsWith('label: '));
    return line ?? '';
  }

  it('names the attached file a view-file macro shows', () => {
    // 233 of these in the EP mirror read `view-file macro — 250` — the height.
    const viewFile =
      '<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="height">250' +
      '</ac:parameter><ac:parameter ac:name="name"><ri:attachment ri:filename="Əlavə 2.docx"/>' +
      '</ac:parameter></ac:structured-macro>';

    // The state is named too (§6.4.13): with no attachment resolver there is nothing
    // on disk, and a widget that only named the file read as a failure of this plugin
    // rather than of the page it came from.
    expect(labelOf(viewFile)).toBe('label: view-file macro — Əlavə 2.docx (not in the vault)');
  });

  it('says only what the macro is when nothing identifies which one', () => {
    const toc =
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter>' +
      '<ac:parameter ac:name="outline">false</ac:parameter></ac:structured-macro>';

    expect(labelOf(toc)).toBe('label: toc macro');
  });

  it('shows the text of a plain-text body too, not only a rich-text one', () => {
    // `code` is intercepted long before this, but `noformat` and its kin are not,
    // and their body is the only thing that says which block the reader is missing.
    const noformat =
      '<ac:structured-macro ac:name="noformat"><ac:plain-text-body>' +
      'SELECT 1</ac:plain-text-body></ac:structured-macro>';

    expect(labelOf(noformat)).toBe('label: noformat macro — SELECT 1');
  });

  it('reads a parameter through the whitespace a formatted body puts between them', () => {
    const spaced =
      '<ac:structured-macro ac:name="drawio">\n  <ac:parameter ac:name="diagramName">Cancel' +
      '</ac:parameter>\n</ac:structured-macro>';

    // Nothing but text nodes between the parameters, but the diagram is still found.
    expect(convert(spaced)).toContain(`![[${MOUNT}/Cancel.png]]`);
  });

  it('says just "macro" for one Confluence sent with no name at all', () => {
    // One of the 26 diagram macros in the EP mirror has no `ac:name`.
    expect(labelOf('<ac:structured-macro ac:schema-version="1"/>')).toBe('label: macro');
  });

  it('ignores an attachment reference with an empty filename', () => {
    const empty =
      '<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="page">' +
      '<ri:attachment ri:filename=""/></ac:parameter></ac:structured-macro>';

    expect(labelOf(empty)).toBe('label: view-file macro');
  });

  it('still shows the text of a macro that wraps content', () => {
    const excerpt =
      '<ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>The summary.</p>' +
      '</ac:rich-text-body></ac:structured-macro>';

    expect(labelOf(excerpt)).toBe('label: excerpt macro — The summary.');
  });
});

describe('a diagram macro that is a bullet, and nothing else in it (§6.4.8)', () => {
  const storage = `<ul><li>${drawio('Cancel')}</li></ul>`;

  it('shows the diagram inside the item', () => {
    expect(convert(storage)).toBe(`- ![[${MOUNT}/Cancel.png]]<!--cf-drawio:cfb-0001-->`);
  });

  it('gives the macro back, and certifies', () => {
    // Read as phrasing — which is what dropping the paragraph wrapper does — the
    // marker means nothing and the embed is an ordinary image: the macro came back
    // as `<ac:image>` plus a literal comment, so a forced push would have replaced
    // a diagram with a picture of it and lost the drawing.
    expect(push(convert(storage), storage)).toBe(storage);
    expect(certified(storage)).toBe(true);
  });
});
