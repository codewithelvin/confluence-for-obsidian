import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Page links inside a preserved table (spec §6.4.18, D27, FR-4.25, closes §16 O19).
 *
 * The shapes are page 91498324's, whose six tables were every one of them refused for
 * this and nothing else: a `Parametrin adı / Daxil edilmə forması / Təsviri` grid whose
 * description column links to the page describing each control.
 */

const BASE = 'https://confluence.cybernet.az';
const MIRRORED = new Map([['EP Ərizələr siyahısı', 'EP/Business Analysis/Ərizələr siyahısı']]);

const OPTIONS: ConversionOptions = {
  baseUrl: BASE,
  spaceKey: 'EP',
  resolveTarget: ({ spaceKey, title }) => MIRRORED.get(`${spaceKey} ${title}`) ?? null,
};

function pageLink(title: string, body: string | null = null, space: string | null = null): string {
  const key = space === null ? '' : ` ri:space-key="${space}"`;
  const text = body === null ? '' : `<ac:plain-text-link-body>${body}</ac:plain-text-link-body>`;
  return `<ac:link><ri:page ri:content-title="${title}"${key}/>${text}</ac:link>`;
}

/** The grid, with the `colspan` Confluence writes and GFM cannot express. */
function grid(cell: string): string {
  return (
    '<table><tbody>' +
    '<tr><td><p><strong>Parametrin adı</strong></p></td><td><p><strong>Təsviri</strong></p></td></tr>' +
    `<tr><td colspan="1">Ərizələr siyahısına</td><td colspan="1">${cell}</td></tr>` +
    '</tbody></table>'
  );
}

function convert(storage: string): string {
  const result = storageToMarkdown(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

function push(markdown: string, storage: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(markdown, forward.value.fragments, OPTIONS);
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

describe('a link to a mirrored page inside a preserved table', () => {
  it('becomes the markup Obsidian resolves as an internal link', () => {
    const markdown = convert(grid(pageLink('Ərizələr siyahısı')));

    expect(markdown).toContain(
      '<a class="internal-link" data-href="EP/Business Analysis/Ərizələr siyahısı"' +
        ' href="EP/Business Analysis/Ərizələr siyahısı">Ərizələr siyahısı</a>',
    );
    // And the grid around it is visible now, which was the whole point.
    expect(markdown).toContain('Parametrin adı');
    expect(markdown).not.toContain('```confluence-block');
  });

  it('leaves the path unencoded, because that is what Obsidian resolves', () => {
    // Percent-encoding `data-href` would stop it resolving — unlike an attachment
    // `<a href>`, which is a URL the operating system opens (§6.4.10).
    expect(convert(grid(pageLink('Ərizələr siyahısı')))).not.toContain('%20');
  });

  it('shows the body text where the link has one', () => {
    expect(convert(grid(pageLink('Ərizələr siyahısı', 'siyahıya keç')))).toContain(
      '>siyahıya keç</a>',
    );
  });

  it('shows the page title where the link is bodyless, as Confluence does', () => {
    expect(convert(grid(pageLink('Ərizələr siyahısı')))).toContain('>Ərizələr siyahısı</a>');
  });

  it('keeps the page certified', () => {
    expect(certified(grid(pageLink('Ərizələr siyahısı')))).toBe(true);
    expect(certified(grid(pageLink('Ərizələr siyahısı', 'siyahıya keç')))).toBe(true);
  });

  it('hands Confluence back the identical link', () => {
    const storage = grid(pageLink('Ərizələr siyahısı', 'siyahıya keç'));
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('restores several in one table, in order', () => {
    const storage = grid(`${pageLink('Ərizələr siyahısı', 'bir')} və ${pageLink('Elsewhere')}`);
    expect(push(convert(storage), storage)).toBe(storage);
  });
});

describe('a link to a page the vault does not hold', () => {
  it('becomes an absolute Confluence URL, which still works', () => {
    // FR-4.7's existing answer for a page link in prose. Unlike a missing file, the
    // page really is there — it is just not here — so a stand-in name would say less.
    const markdown = convert(grid(pageLink('Somewhere Else')));

    expect(markdown).toContain(`<a href="${BASE}/display/EP/Somewhere+Else">Somewhere Else</a>`);
    expect(markdown).not.toContain('internal-link');
    expect(markdown).not.toContain('```confluence-block');
  });

  it('reads the space off the link where it names one', () => {
    expect(convert(grid(pageLink('Runbook', null, 'OPS')))).toContain('/display/OPS/Runbook');
  });

  it('keeps that page certified too', () => {
    expect(certified(grid(pageLink('Somewhere Else')))).toBe(true);
  });
});

describe('what a page link still cannot do', () => {
  it('refuses the table when the link names no page', () => {
    const nameless = '<ac:link><ri:page ri:content-title=""/></ac:link>';
    expect(convert(grid(nameless))).toContain('```confluence-block');
  });

  it('leaves a user mention refusing the table, which is not this decision', () => {
    // `ri:userkey` is all the storage holds — the display name needs a lookup a pure
    // converter cannot make, so there is nothing to draw.
    const user = '<ac:link><ri:user ri:userkey="ff8081"/></ac:link>';
    expect(convert(grid(user))).toContain('```confluence-block');
  });

  it('leaves a cross-page anchor alone, which is O25', () => {
    const anchor =
      '<ac:link ac:anchor="_Toc1"><ri:content-entity ri:content-id="9"/>' +
      '<ac:plain-text-link-body>x</ac:plain-text-link-body></ac:link>';
    expect(convert(grid(anchor))).toContain('```confluence-block');
  });

  it('still shows an attachment link beside a page link, as §6.4.10 did', () => {
    // The two passes must not fight: page links go first, and the media pass then sees
    // only the links it understands.
    const options: ConversionOptions = { ...OPTIONS, resolveAttachment: () => 'EP/_att/a.pdf' };
    const cell = `${pageLink('Ərizələr siyahısı')} <ac:link><ri:attachment ri:filename="a.pdf"/></ac:link>`;

    const result = storageToMarkdown(grid(cell), options);
    if (!result.ok) throw new Error(result.error.userMessage);

    expect(result.value.markdown).toContain('internal-link');
    expect(result.value.markdown).toContain('href="EP/_att/a.pdf"');
    expect(result.value.markdown).not.toContain('```confluence-block');
  });
});
