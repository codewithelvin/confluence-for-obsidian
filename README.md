# Confluence 4 Obsidian

An Obsidian plugin that turns a Confluence **Data Center** space — or any subtree of it — into a live, editable working copy inside your vault.

The model is the one developers already have with source code: **pull, edit locally in a fast editor, push back.** Confluence stays the system of record; Obsidian becomes the editing surface.

> **Status: feature-complete, not yet released.** Every milestone is built and the test suite is green, but the write path has not yet been exercised against a production instance and the plugin has been verified against one Confluence version only. Treat it as a beta and keep backups.

## Requirements

- Obsidian **desktop** 1.5.3 or later. **Mobile is not supported and never will be** — the plugin stores your token through the operating system keychain, which is unavailable on mobile.
- Confluence **Data Center or Server 7.9+** (the minimum for Personal Access Tokens).
- Permission to create a Personal Access Token, and network access to your instance.

**Confluence Cloud is not supported.** Cloud uses a different API and a different content format; this plugin targets Data Center exclusively.

## Install

Until the plugin is in the community catalogue, install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/codewithelvin/confluence-for-obsidian/releases).
2. Put all three in `<your-vault>/.obsidian/plugins/confluence-dc-connector/`.
3. Reload Obsidian and enable **Confluence 4 Obsidian** under **Settings → Community plugins**.

### Creating a Personal Access Token

1. In Confluence, open your profile menu → **Settings** → **Personal Access Tokens**.
2. **Create token**, give it a name, and set an expiry you are comfortable with.
3. Copy the token — Confluence shows it once.
4. In Obsidian: **Settings → Confluence 4 Obsidian → Connections → Add connection**. Enter your site URL (for example `https://confluence.example.com`) and paste the token, then **Test connection**.

The token is encrypted through the operating system keychain (Electron `safeStorage`) and never written to the vault in plain text, so a vault synced to Dropbox, iCloud or git leaks nothing usable. Where the keychain is unavailable — some Linux desktops — the token is held in memory for the session only and you will be asked for it again next time. It is never stored unencrypted.

### If your instance uses a private certificate authority

Install the CA's root certificate in your **operating system trust store**. The plugin deliberately ships no option to disable certificate validation, because the alternative is a setting whose only purpose is to make interception invisible. A TLS problem is reported as `TLS_UNTRUSTED` with this remedy rather than as a generic connection failure.

## How the mirror is laid out

One folder per space, one node per page:

```
EP/                       ← the mount; named after the space by default, rename it freely
  EP.md                   ← the space home page, collapsed into the mount
  Architecture/           ← a page that has children
    Architecture.md       ← its body
    API Gateway.md        ← a leaf child
  Release Notes.md
  _attachments/
    123456789/
      diagram.png
```

A page with children becomes a folder plus a same-named note inside it. A page that later loses all its children **keeps** its folder — demotion is never automatic, because reshaping the tree on every child added and removed would move your files twice for one edit. Run **Tidy folder notes** when you want the folders cleared.

Each note carries a `confluence:` block in its frontmatter holding the page id, space, version and URL. That block is the plugin's; every other frontmatter key is yours and survives every write untouched.

## The fidelity model

Confluence stores pages as XHTML with its own `ac:` and `ri:` markup. Markdown cannot express all of it, and the plugin never pretends otherwise.

- What Markdown **can** express is converted: headings, emphasis, lists, links, tables, code blocks, panels, task lists, images.
- What **HTML** can express but Markdown cannot — a coloured span, an underline, an aligned paragraph, a table with merged cells — is written into the note as that HTML. Obsidian renders it.
- Everything else — macros, layouts, whiteboards — is preserved **verbatim** in the plugin's own storage and shown in the note as a labelled placeholder. It is never discarded and never guessed at.
- Markup Confluence itself renders as _nothing_ is dropped rather than preserved, because a mirror full of grey placeholders for invisible markup is a mirror nobody reads. A per-connection **Strict markup** switch turns that off and keeps byte-fidelity instead.

Every page is checked at pull time by converting it back and comparing:

| Marked                | Meaning                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fidelity: certified` | The page survived a full round trip. It can be edited and pushed.                                                                                 |
| `fidelity: degraded`  | Something in the page did not come back identical. The note is **read-only**; push is refused and you are offered the page in Confluence instead. |

A second check runs before any individual push: your edit is converted to storage format and back, and the push is blocked if the result differs. The two checks answer different questions — whether the page _can ever_ be pushed, and whether _this edit_ can.

## What it refuses to do, and why

These refusals are the product, not gaps in it.

- **A sync never publishes.** Pulling is automatic; pushing is always a command you ran. A sync reports local edits and raises conflicts, but nothing reaches Confluence without you asking.
- **A sync never creates a page.** A new Markdown file in a mount is reported as an untracked candidate. Use **Publish this note as a new Confluence page** when you mean it.
- **Deleting a note never deletes a page.** The page becomes an orphan, listed in the sync panel with an explicit _Delete in Confluence_ action. Deleting a page requires typing its exact title.
- **A degraded page cannot be pushed.** Not with a warning, not with a checkbox — the command declines and offers Confluence instead.
- **An edit that does not round-trip is not sent.** Force push exists, is off by default, and demands typed confirmation each time.
- **The plugin never deletes an attachment from Confluence.** It only ever uploads.
- **Conflicts are never merged automatically.** You get Keep Local, Keep Remote or Save Both, per page, with a diff.
- **Nothing is written outside the mount folder.** Backups live in the plugin's own state directory, not in your vault.

## Commands

All commands appear in the palette with no default hotkeys.

| Command                                    | What it does                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Sync all subscriptions                     | Pulls every subscription; reports conflicts, orphans and untracked notes |
| Pull this page from Confluence             | Re-pulls the active note, comments included                              |
| Push this page to Confluence               | Pushes the active note through every gate                                |
| Push all locally modified pages            | Pushes every changed note in each subscription                           |
| Stop the push in progress                  | Stops a batch push after the page it is on                               |
| Create a page in Confluence                | Creates a page under a chosen parent and writes its note                 |
| Publish this note as a new Confluence page | Publishes a note you wrote yourself                                      |
| Delete this page in Confluence             | Trashes the page and removes the note; typed confirmation                |
| Tidy folder notes                          | Moves childless folder notes back out of their folders                   |
| Open this page in Confluence               | Opens the active note's page in the browser                              |
| Open the sync panel                        | The sidebar view: status, conflicts, orphans, errors                     |
| Check conversion fidelity of a space       | Diagnostic: samples a space and reports what would convert               |

## Troubleshooting

**"Your Confluence account does not have permission for this action."**
Confluence's own explanation follows the message as _Confluence said: …_. A 403 on creating a page is usually a missing _Add Page_ permission in the space, or an edit restriction on the parent page.

**A page is read-only and I cannot push it.**
It is marked `fidelity: degraded` in its frontmatter — see the fidelity model above. Edit it in Confluence, then pull.

**A new comment has not appeared.**
Comments arrive with the page body. A sync asks the server once per subscription which pages have new comments, so a remark on an untouched page does reach the mirror — but only if comment sync is on for that subscription and the note has not been edited locally. **Pull this page from Confluence** always fetches them.

**A note I created has not been published.**
By design (FR-7.2). Run **Publish this note as a new Confluence page**.

**"Refused to write … past the 240-character limit."**
The vault is too deep for the page's path. Move the vault closer to the drive root, or shorten the mount folder name. Long paths are the one Windows limit the plugin cannot work around, and it refuses rather than letting the write fail with an unreadable OS error.

**Something else went wrong.**
Turn on **Debug logging** in settings and reproduce it with the developer console open (`Ctrl+Shift+I`). Tokens are redacted from every log line.

## Known limitations

- **One Confluence version verified.** Developed and tested against Data Center 7.19.6.
- **Macros are placeholders, not live content.** Rendering them would need a Confluence render pass.
- **Comments are read-only.** They can be pulled, not written.
- **No background sync.** Syncing is a command; automatic syncing multiplies conflict scenarios.
- **No three-way merge.** Conflicts are resolved by explicit choice.
- **Blog posts, whiteboards and databases are out of scope.**
- **Conversion runs on the main thread.** A very large page can briefly make the UI unresponsive.

## Development

```bash
npm install
npm run dev      # watch build
npm run verify   # typecheck + lint + boundaries + format + tests
npm run build    # production bundle
```

To test in a real vault, copy `main.js`, `manifest.json` and `styles.css` into
`<your-vault>/.obsidian/plugins/confluence-dc-connector/`, then enable the plugin in
**Settings → Community plugins**. `npm run install:test` does this for the local test vault.

### Architecture rules

These are enforced by ESLint and fail the build:

- Layer boundaries — dependencies point downward only (UI → Commands → Orchestration → Domain → Gateways).
- All Confluence HTTP goes through `ConfluenceClient`; all vault I/O goes through `VaultGateway`.
- Converters are pure functions: no I/O, no clock, no randomness.
- `innerHTML`, `outerHTML` and `insertAdjacentHTML` are banned. Confluence content is untrusted input.
- 300 lines per file, 50 per function.
- No runtime dependency may be added without explicit approval.

The full specification lives outside this repository and is the authority on all of the above.

## Licence

MIT © Elvin Huseynov
