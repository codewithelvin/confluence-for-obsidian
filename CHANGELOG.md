# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

<!-- Note: entries for the read-only sync (M3) and the write path (M5) were never
     added and are missing above. -->

[Unreleased]: https://github.com/codewithelvin/confluence-for-obsidian/commits/main
