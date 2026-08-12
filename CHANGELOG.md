# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-08-12

First public build, released as a prerelease: every milestone is present, and the
write paths have been exercised against one Confluence Data Center 7.19.6 server
in one space. Treat it as a beta until a second server has confirmed them.

### Added

- Project skeleton: TypeScript strict build via esbuild, ESLint with enforced
  layer boundaries, Prettier, Vitest with coverage gates, and CI/release
  workflows.
- Plugin lifecycle with settings persistence, validation of untrusted
  `data.json` contents, and a settings tab.
- Logging with mandatory secret redaction, covering both pattern-matched
  credentials and registered live tokens.
- Confluence Data Center gateway: REST v1 client with bearer authentication,
  pagination, bounded concurrency, and retry with full-jitter backoff that
  honours `Retry-After`.
- Personal Access Token storage encrypted through the operating system
  keychain, degrading to memory-only rather than plaintext when unavailable.
- Server version detection with an ordered fallback chain, treating an
  undetectable version as unknown rather than unsupported.
- Connection management, connection testing, and a searchable space browser.
- `npm run lint:boundaries`, which proves the architecture rules reject
  violations instead of merely being configured to.
- Storage-format ↔ Markdown converter: headings, inline marks, lists, tables,
  links, code macros, info/note/warning/tip panels, expand macros and task
  lists, with everything else preserved verbatim as an opaque placeholder.
- Both fidelity checks: pull-time certification decides whether a page can ever
  be pushed safely, and push-time verification decides whether a specific edit
  can. Neither ever guesses.
- Golden corpus of 60 fixtures asserting 100% idempotence plus lossless
  round-tripping wherever claimed, regenerated with `npm run test:bless`.
- Confluence labels are merged into a note's `tags`, and tag changes are pushed
  back as label add and remove calls. Only the labels the plugin itself wrote are
  ever removed, and a tag Confluence cannot store as a label is reported rather
  than dropped.
- Page comments are pulled into a collapsed block at the end of each note,
  switchable per subscription and per note (`confluenceComments: false`). The
  block is regenerated on every pull and is never pushed back.
- Files a note embeds but the page does not have are uploaded on push, after
  every gate has passed: an attachment cannot be un-sent, so nothing is uploaded
  for a page that turns out not to be writable.
- A push whose body is already byte-identical to the page no longer writes a
  version, so changing only a tag leaves no empty entry in the page's history.
- Subscriptions: a space or any page subtree of it mirrors into a mount folder,
  with a page-count warning before a large first sync.
- Read-only sync: the full subtree is enumerated each run and only pages whose
  version moved are fetched, so a re-sync of a thousand pages costs a handful of
  requests. Moves and renames made in Confluence move the local files with them.
- Folder-note layout: a page with children is stored as `Page/Page.md`, and the
  subscription's root page collapses into the mount folder itself.
- The sync panel: per-subscription status, pending local changes, conflicts,
  orphans, untracked candidates, conflict copies and errors, with a status-bar
  item beside it.
- Attachments are downloaded beside the pages that reference them, skipped over a
  configurable size limit, and re-fetched only when their remote version moves.
- The write path: push with four gates — certified page, fragments present,
  round-trip verification, and a re-read of the remote version immediately before
  writing — plus a conflict modal offering Keep Local, Keep Remote and Save Both,
  and a backup before every destructive local write.
- Force push, off by default, behind a setting and a typed confirmation per use.
- Structure: create, publish, delete, move and rename, each previewed and
  confirmed before anything is sent. Deleting a note locally produces an orphan
  that is reported, never a remote deletion.
- `Tidy folder notes` performs §6.5.4's bulk demotion on request: folder notes
  whose page no longer has children move back out of their folders, and one whose
  folder still holds anything else is reported rather than moved.
- Inline placeholders now render as a pill in **Live Preview** as well as Reading
  View, so a mirrored page never shows a reader a raw `{cf:…}` sentinel.
- A comment added to an otherwise unchanged page now reaches the mirror. One CQL
  query per subscription per sync names the pages whose comments moved, and they
  are pulled again; a note with local edits is left alone.
- A batch push reports progress, hands the UI thread back between pages, and can
  be stopped with `Stop the push in progress`.
- A write whose path would exceed the 240-character budget is refused with a typed
  `PATH_TOO_LONG` error naming the remedy, rather than failing with the operating
  system's own unreadable error.
- Draw.io diagrams appear in the note as the picture Confluence shows. The macro
  holds only a name, so the diagram is found as the page attachment that backs its
  preview. Editing one is refused rather than deferred: the drawing itself lives in
  the app, and a push from here would leave every Confluence reader on a stale
  image.
- Emoticons become their Unicode character instead of an opaque placeholder, over
  the 16 names that have an honest glyph.
- A table too complex to become Markdown is preserved as HTML, and the images and
  attachment links inside it now render there too, in both editing modes, rather
  than being reduced to placeholders with the rest of the table.
- The `children` and `toc` macros are rebuilt from the vault when the note is
  displayed, so the navigation Confluence generates is present and its links go to
  the mirrored notes. Only the parameterless form is rebuilt; anything naming
  another page stays a placeholder.
- An `include` macro becomes an embed of the note it names, so the included page's
  content is visible in place, as it is in Confluence.

[Unreleased]: https://github.com/codewithelvin/confluence-for-obsidian/compare/0.0.1...main
[0.0.1]: https://github.com/codewithelvin/confluence-for-obsidian/releases/tag/0.0.1
