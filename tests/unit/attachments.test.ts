import { describe, expect, it } from 'vitest';
import { referencedAttachments } from '../../src/convert/attachments';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';
import { sanitiseFileName } from '../../src/vault/filename-sanitiser';
import { attachmentPath } from '../../src/vault/path-mapper';

/**
 * Attachments and image embeds (spec FR-8.1, FR-8.2).
 *
 * The converter half only: whether an `ac:image` becomes an embed, and whether
 * the embed converts back. What gets downloaded is the executor's business and is
 * covered through the engine.
 */

const DOWNLOADED = new Map([['Homepage.jpg', 'EP/_attachments/123/Homepage.jpg']]);

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://wiki.corp',
  spaceKey: 'EP',
  resolveAttachment: (filename: string): string | null => DOWNLOADED.get(filename) ?? null,
  attachmentFor: (path: string): string | null => {
    for (const [filename, candidate] of DOWNLOADED) {
      if (candidate === path) return filename;
    }
    return null;
  },
};

function convert(storage: string, options: ConversionOptions = OPTIONS): string {
  const result = storageToMarkdown(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string, options: ConversionOptions = OPTIONS): boolean {
  const result = certify(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

function image(inner: string, attributes = ''): string {
  return `<p><ac:image${attributes}>${inner}</ac:image></p>`;
}

const ATTACHED = '<ri:attachment ri:filename="Homepage.jpg"/>';

describe('an image whose attachment is on disk', () => {
  it('becomes an Obsidian embed', () => {
    expect(convert(image(ATTACHED))).toBe('![[EP/_attachments/123/Homepage.jpg]]');
  });

  it('round-trips back to the same ac:image', () => {
    expect(certified(image(ATTACHED))).toBe(true);
  });

  it('carries a width, which Obsidian reads as a pixel width', () => {
    const sized = image(ATTACHED, ' ac:width="50"');

    expect(convert(sized)).toBe('![[EP/_attachments/123/Homepage.jpg|50]]');
    expect(certified(sized)).toBe(true);
  });
});

describe('an image that stays a placeholder', () => {
  it('stays one when the attachment was never downloaded', () => {
    const missing = image('<ri:attachment ri:filename="Never.png"/>');

    // A broken embed is worse than an honest label: the reader can see that
    // something is preserved rather than that something is gone.
    expect(convert(missing)).toContain('{cf:');
    expect(convert(missing)).not.toContain('![[');
    expect(certified(missing)).toBe(true);
  });

  it('stays one for an external image, which is not an attachment at all', () => {
    const external = image('<ri:url ri:value="https://example.com/x.png"/>');

    expect(convert(external)).toContain('{cf:');
    expect(certified(external)).toBe(true);
  });

  it('stays one when no resolver is supplied at all', () => {
    const bare = { baseUrl: 'https://wiki.corp', spaceKey: 'EP' };

    expect(convert(image(ATTACHED), bare)).toContain('{cf:');
    expect(certified(image(ATTACHED), bare)).toBe(true);
  });
});

describe('an image an embed cannot fully describe', () => {
  it('shows anyway, with its source carried beside it', () => {
    // `ac:thumbnail` has no embed form. Preserving the whole image for it hid a
    // picture whose file was already downloaded; carrying the source in a comment
    // shows the picture and still hands Confluence back the thumbnail.
    const thumbnail = image(ATTACHED, ' ac:thumbnail="true"');

    expect(convert(thumbnail)).toBe('![[EP/_attachments/123/Homepage.jpg]]<!--cf-img:cfb-0001-->');
    expect(certified(thumbnail)).toBe(true);
  });
});

describe('an embed the user wrote', () => {
  it('is left alone when it points at a file of their own', () => {
    // Uploading it is FR-8.6, not this. Inventing an `ac:image` for a file
    // Confluence has never seen would push a reference to nothing.
    const storage = '<p>See <ac:image>' + ATTACHED + '</ac:image> and my own.</p>';
    const markdown = convert(storage);

    expect(markdown).toContain('![[EP/_attachments/123/Homepage.jpg]]');
  });
});

describe('which attachments a body refers to (FR-8.5)', () => {
  it('finds every ri:filename, whatever construct holds it', () => {
    const storage =
      '<p><ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>' +
      '<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name">' +
      '<ri:attachment ri:filename="spec.docx"/></ac:parameter></ac:structured-macro>';

    expect([...referencedAttachments(storage)].sort()).toEqual(['a.png', 'spec.docx']);
  });

  it('decodes the entities an attribute value can carry', () => {
    const storage = '<ac:image><ri:attachment ri:filename="a &amp; b.png"/></ac:image>';

    expect([...referencedAttachments(storage)]).toEqual(['a & b.png']);
  });

  it('finds nothing in a body with no attachments', () => {
    expect(referencedAttachments('<p>Just prose.</p>').size).toBe(0);
  });
});

describe('where an attachment is written (FR-8.1)', () => {
  it('goes under the mount, keyed by page id', () => {
    // Keyed by id rather than by page path, so an attachment does not move when
    // its page is renamed — the embed keeps working through a reorganisation.
    expect(attachmentPath('EP', '22020124', 'Homepage.jpg')).toBe(
      'EP/_attachments/22020124/Homepage.jpg',
    );
  });

  it('sanitises the name without breaking the extension', () => {
    // Obsidian identifies an image by its extension, so `con.png_` is the
    // difference between a picture and an unknown file.
    expect(sanitiseFileName('con.png')).toBe('con_.png');
    expect(sanitiseFileName('a/b.png')).toBe('a-b.png');
    expect(sanitiseFileName('no-extension')).toBe('no-extension');
    expect(sanitiseFileName('.hidden')).toBe('.hidden');
  });
});
