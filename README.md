# Confluence 4 Obsidian

An Obsidian plugin that turns a Confluence **Data Center** space — or any subtree of it — into a live, editable working copy inside your vault.

The model is the one developers already have with source code: **pull, edit locally in a fast editor, push back.** Confluence stays the system of record; Obsidian becomes the editing surface.

> **Status: in development.** Not yet usable. You can connect to a Confluence Data Center instance and browse its spaces, but nothing is mirrored into the vault yet — syncing arrives in M3. See the roadmap below.

## Requirements

- Obsidian **desktop** 1.5.3 or later. **Mobile is not supported and never will be** — the plugin stores your token through the operating system keychain, which is unavailable on mobile.
- Confluence **Data Center or Server 7.9+** (the minimum for Personal Access Tokens).
- Permission to create a Personal Access Token, and network access to your instance.
- If your instance uses a private certificate authority, its root certificate must be installed in your **operating system trust store**. The plugin deliberately ships no option to disable certificate validation.

**Confluence Cloud is not supported.** Cloud uses a different API and content format; this plugin targets Data Center exclusively.

## Design commitments

These are deliberate, not accidental:

- **No silent data loss.** Every push is gated by a round-trip verification. If an edit cannot be converted back to Confluence storage format faithfully, the push is **blocked** rather than attempted.
- **Content is preserved, not guessed at.** Macros, layouts and other constructs Markdown cannot express are preserved verbatim and re-injected on push, shown in the note as placeholder blocks.
- **Deleting a note never deletes a Confluence page.** Deletion always requires an explicit command with typed confirmation.
- **Your token never touches the vault in plaintext.** It is encrypted through the OS keychain, so a vault synced to Dropbox, iCloud or git leaks nothing.

## Roadmap

| Milestone | Scope                                                      | Status                                                    |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| M0        | Build, lint, test harness, plugin lifecycle, settings      | ✅ Complete                                               |
| M1        | Confluence client, PAT authentication, space browser       | ✅ Complete, verified against a live Data Center instance |
| M2        | Storage-format ↔ Markdown converter, fidelity verification | ✅ Complete — 71-fixture corpus, 100% idempotence         |
| M3        | Subscriptions, read-only sync, folder hierarchy            | Next                                                      |
| M4        | Attachments, labels, comments                              |                                                           |
| M5        | Push with verification, conflict resolution                |                                                           |
| M6        | Create, delete, move, rename                               |                                                           |
| M7        | Hardening, docs, community-plugin submission               |                                                           |

## Development

```bash
npm install
npm run dev      # watch build
npm run verify   # typecheck + lint + format + tests
npm run build    # production bundle
```

To test in a real vault, symlink or copy `main.js`, `manifest.json` and `styles.css` into
`<your-vault>/.obsidian/plugins/confluence-dc-connector/`, then enable the plugin in
**Settings → Community plugins**.

### Architecture rules

These are enforced by ESLint and fail the build:

- Layer boundaries — dependencies point downward only (UI → Commands → Orchestration → Domain → Gateways).
- All Confluence HTTP goes through `ConfluenceClient`; all vault I/O goes through `VaultGateway`.
- Converters are pure functions: no I/O, no clock, no randomness.
- `innerHTML`, `outerHTML` and `insertAdjacentHTML` are banned. Confluence content is untrusted input.
- No runtime dependency may be added without explicit approval.

The full specification lives outside this repository and is the authority on all of the above.

## Licence

MIT © Elvin Huseynov
