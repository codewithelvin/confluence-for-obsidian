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

[Unreleased]: https://github.com/codewithelvin/confluence-for-obsidian/commits/main
