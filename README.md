# Confluence 4 Obsidian

**Read and edit your company's Confluence pages in Obsidian.**

This plugin copies pages out of Confluence into your vault as ordinary Markdown notes. You
edit them in Obsidian — fast, offline, with links and search and every plugin you already
use — and when you are ready, you send your changes back. Confluence stays the official
copy. Obsidian just becomes a much nicer place to do the writing.

If you have ever worked with code in a Git repository, the idea is the same one: **pull,
edit locally, push back.**

> ### ⚠️ Please read before you start
>
> This is version **0.0.1** and it is a **beta**. It has been tested thoroughly against one
> Confluence version (Data Center 7.19.6) and against thousands of real pages, but it has
> not yet been through a full supervised release test.
>
> **Try it on a space that does not matter first.** Make a scratch space in Confluence, or
> ask for one, and practise there before you point it at anything your colleagues rely on.
> The plugin is built to refuse rather than guess — but a beta is a beta.

---

## Table of contents

1. [What it does, in one screen](#what-it-does-in-one-screen)
2. [Before you start](#before-you-start)
3. [Step-by-step setup](#step-by-step-setup)
   - [Step 1 — install the plugin](#step-1--install-the-plugin)
   - [Step 2 — get a token from Confluence](#step-2--get-a-token-from-confluence)
   - [Step 3 — connect Obsidian to your site](#step-3--connect-obsidian-to-your-site)
   - [Step 4 — choose what to mirror](#step-4--choose-what-to-mirror)
   - [Step 5 — your first sync](#step-5--your-first-sync)
4. [What ends up in your vault](#what-ends-up-in-your-vault)
5. [The everyday loop](#the-everyday-loop)
6. [Ten things every user should know](#ten-things-every-user-should-know)
7. [What the grey boxes mean](#what-the-grey-boxes-mean)
8. [When a page is read-only](#when-a-page-is-read-only)
9. [When two people edited the same page](#when-two-people-edited-the-same-page)
10. [Commands](#commands)
11. [Settings](#settings)
12. [Troubleshooting](#troubleshooting)
13. [What it deliberately will not do](#what-it-deliberately-will-not-do)
14. [Known limits](#known-limits)
15. [For developers](#for-developers)

---

## What it does, in one screen

**It does this:**

- Copies a whole Confluence space — or just one page and everything under it — into a
  folder in your vault, as normal `.md` files.
- Keeps the page tree as a folder tree, so the shape you know from Confluence is the shape
  you see in the file explorer.
- Converts what Markdown can express (headings, lists, tables, links, code, panels, task
  lists, images) and **preserves everything else exactly**, so nothing is ever lost.
- Downloads attachments so images actually show up.
- Turns Confluence links between pages into real Obsidian links, so graph view and
  backlinks work across your wiki.
- Sends your edits back when you ask it to — title, body, tags and new attachments.
- Tells you when someone else changed a page you were editing, and lets you decide what to
  do about it.

**It does not do this:**

- It does not work with **Confluence Cloud**. Data Center and Server only.
- It does not work on **mobile**. Desktop Obsidian only.
- It does not push anything to Confluence unless you run a command that says so.
- It does not merge conflicting edits for you.
- It does not delete anything in Confluence unless you explicitly ask, by name.

---

## Before you start

You need four things:

| What                                  | Details                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Obsidian on desktop**               | Version 1.5.3 or newer. Windows, macOS or Linux. Mobile is not supported.                            |
| **Confluence Data Center or Server**  | Version 7.9 or newer, which is when Personal Access Tokens were introduced. **Cloud will not work.** |
| **Permission to make a token**        | Most instances allow this by default. If yours does not, ask your Confluence administrator.          |
| **Network access to your Confluence** | If you normally need a VPN to reach the wiki, you need it here too.                                  |

**Why not mobile?** Your Confluence token is stored using your operating system's own
password vault (Keychain on macOS, Credential Manager on Windows). Mobile Obsidian has no
equivalent, and writing a token into a vault that syncs to a cloud service would be
irresponsible. So the plugin declares itself desktop-only rather than shipping a weaker
option.

---

## Step-by-step setup

Allow about ten minutes for the whole thing.

### Step 1 — install the plugin

The plugin is not in Obsidian's community catalogue yet, so you install it from its
[releases page](https://github.com/codewithelvin/confluence-for-obsidian/releases). Pick
either way below.

#### Option A — the zip (simplest)

1. From the newest release, download **`confluence-dc-connector-<version>.zip`**.

2. Find your vault's folder on disk. In Obsidian: **Settings → About → Advanced**, or
   right-click any file → **Show in system explorer**.

3. Open the `.obsidian/plugins/` folder inside your vault, creating `plugins` if it is not
   there.

   > `.obsidian` starts with a dot, which means your file manager may be hiding it. On
   > Windows, tick **Hidden items** in File Explorer's View tab. On macOS, press
   > <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>.</kbd> in Finder.

4. Unzip the download **into** `plugins/`. The zip already contains a
   `confluence-dc-connector/` folder, so you end up with
   `.obsidian/plugins/confluence-dc-connector/` holding three files. Do not rename that
   folder — Obsidian identifies the plugin by it.

5. Back in Obsidian, open **Settings → Community plugins**. If restricted mode is on, turn it
   off. Then click the reload icon next to **Installed plugins**, find
   **Confluence 4 Obsidian**, and switch it on.

#### Option B — BRAT (updates itself)

If you expect to follow updates during the beta, this saves you repeating Option A every
time.

1. Install the community plugin **BRAT** (Beta Reviewers Auto-update Tool) the normal way,
   from **Settings → Community plugins → Browse**.
2. Run the command **BRAT: Add a beta plugin for testing**.
3. Paste `codewithelvin/confluence-for-obsidian` and confirm, ticking the option to enable it
   after installing.

BRAT then checks for new releases and updates the plugin for you. Because this is still a
`0.x` beta, its releases are marked as prereleases — so turn on BRAT's prerelease setting
(**Enable beta plugin updates**) or it will not see them.

Either way you should end up with **Confluence 4 Obsidian** in the left-hand list of your
settings window.

> **Prefer to place the files yourself?** Every release also carries `main.js`,
> `manifest.json` and `styles.css` as separate downloads — that is the form BRAT and
> Obsidian's own catalogue fetch. Drop those three into
> `.obsidian/plugins/confluence-dc-connector/` instead of using the zip.

### Step 2 — get a token from Confluence

A Personal Access Token is a long password that stands in for your login. The plugin uses
one instead of asking for your real password.

1. Open Confluence in your browser and sign in as yourself.
2. Click your **profile picture** in the top-right corner → **Settings**.
3. In the left menu, find **Personal Access Tokens**.
4. Click **Create token**.
5. Give it a name you will recognise later — `Obsidian` is fine.
6. Choose an expiry. Whatever your company's policy allows; a year is common. Note the date
   somewhere, because when it expires the plugin will stop working and you will need to
   repeat this step.
7. Click **Create**, then **copy the token**.

> **Copy it now.** Confluence shows the token exactly once. If you lose it, you cannot look
> it up — you have to delete it and make a new one.

**A note about permissions:** the token does not grant any new access. It acts as _you_, so
it can read exactly what you can read and edit exactly what you can edit. If you cannot
edit a page in your browser, the plugin cannot either.

### Step 3 — connect Obsidian to your site

1. In Obsidian, open **Settings → Confluence 4 Obsidian**.
2. Under **Connections**, click **Add connection**.
3. Fill in three fields:

   | Field                     | What to put                                                                                                                                                                                                                                                                      |
   | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Name**                  | Anything that helps you recognise it — `Corporate wiki`.                                                                                                                                                                                                                         |
   | **Base URL**              | The address of your Confluence, exactly as it appears in your browser's address bar, **including any path**. So `https://wiki.example.com/confluence` if that is what you see, or just `https://confluence.example.com` if there is nothing after the domain. No trailing slash. |
   | **Personal Access Token** | Paste the token from Step 2.                                                                                                                                                                                                                                                     |

   Leave **Strict markup** off. It is an expert option explained in the settings section
   below.

4. Click **Save**.
5. Click **Test** next to your new connection.

You should see a notice naming _you_ — that confirms the URL is right, the token works, and
the plugin is talking to the correct instance.

**If the test fails,** jump to [Troubleshooting](#troubleshooting). The two most common
causes are a wrong Base URL (a missing `/confluence` path is the classic one) and a token
that was copied incompletely.

**Where does the token live?** It is encrypted by your operating system and stored outside
your vault. It is never written into a note, never into your vault's settings files, and
never printed in a log. If your vault syncs to Dropbox, iCloud, OneDrive or Git, none of
those ever sees your token. On a few Linux desktops there is no system vault available — in
that case the plugin holds the token in memory for the session only, tells you so, and asks
again after a restart. It never falls back to storing it unencrypted.

### Step 4 — choose what to mirror

A **subscription** is one instruction: _mirror this space (or this page and its children)
into this folder._

1. Still in **Settings → Confluence 4 Obsidian**, under **Subscriptions**, click **Add
   subscription**.
2. **Connection** — pick the one you just made.
3. **Space** — click **Choose space** and pick from the list. This is fetched live from
   your Confluence, so you only see spaces you can actually read.
4. **Root page ID** — leave it **empty** to mirror the whole space.

   To mirror only part of a space, open the top page of the part you want in your browser,
   find its page ID, and paste it here. The ID is the number in the URL: if the address bar
   shows `…/pages/viewpage.action?pageId=146743218`, the ID is `146743218`. If your URL
   shows a title instead of an ID, click **⋯ → Page Information** and read the ID from that
   URL.

   > **Strong advice for your first try:** pick a small subtree, not a whole space. Ten
   > pages tells you everything a thousand pages would, in a fraction of the time.

5. **Vault folder** — the folder in your vault that will hold the mirror. It defaults to the
   space key. It is created for you. **Use a folder that is empty or does not exist yet.**
6. Click **Subscribe**.

### Step 5 — your first sync

1. Press <kbd>Ctrl</kbd> + <kbd>P</kbd> (<kbd>⌘</kbd> + <kbd>P</kbd> on macOS) to open the
   command palette.
2. Type `sync` and run **Sync all subscriptions**.

   Or click **Sync now** next to the subscription in settings.

3. Watch the notices. A large space takes a while — it reads every page, converts it,
   downloads attachments and writes files.

4. When it finishes, run **Open the sync panel** from the palette. This is a sidebar view
   that tells you what happened: how many pages arrived, anything that could not be
   converted cleanly, anything that needs your attention.

Now open your new folder in the file explorer and read a few pages. **That is the whole
setup.** From here on, syncing is one command.

---

## What ends up in your vault

One folder per subscription, and the page tree becomes a folder tree:

```
EP/                          ← your "vault folder" from Step 4
  EP.md                      ← the space's home page
  Architecture/              ← a page that has child pages becomes a folder…
    Architecture.md          ← …plus a note inside it with the same name, holding its text
    API Gateway.md           ← a child page with no children of its own
    Data Model.md
  Release Notes.md           ← a page with no children is just a file
  _attachments/
    146743218/               ← one folder per page, named with the page's ID
      diagram.png
      spec.xlsx
```

**Why the same-named note inside the folder?** Because in Confluence a page can have text
_and_ children at the same time, and a folder on disk cannot hold text. So a page with
children becomes a folder plus a note of the same name — Obsidian calls this a folder note,
and it displays neatly.

**One thing that surprises people:** if a page loses all its children, its folder stays. The
plugin does not reshape your folder tree every time someone adds or removes a child page —
that would move your files back and forth for one small edit in Confluence. When you want
those leftover folders cleaned up, run **Tidy folder notes** and it does them all at once,
telling you about any it refused to touch.

### The `confluence:` block at the top of each note

Every mirrored note starts with something like this:

```yaml
---
confluence:
  id: '146743218'
  space: EP
  version: 12
  parent: '146743210'
  url: https://confluence.example.com/pages/viewpage.action?pageId=146743218
  updated: '2026-08-12T09:14:33.000Z'
  updatedBy: a.colleague
  fidelity: certified
---
```

That block belongs to the plugin — it is how the note knows which page it is. **Do not edit
it by hand.**

Everything _else_ in the frontmatter is yours. Add your own keys, your own tags, your own
aliases; the plugin writes around them and never touches them. (Two exceptions it shares
rather than owns: `tags`, where it keeps the entries standing for Confluence labels, and
`aliases`, where it keeps one entry for the page's real title if the filename had to be
changed to be legal on your operating system.)

---

## The everyday loop

Once you are set up, real work looks like this:

1. **Sync** — run **Sync all subscriptions** when you sit down. New and changed pages come
   in; your unmodified notes are updated; anything needing your attention is listed in the
   sync panel.

2. **Edit** — open a note and write. It is a normal Markdown file. Use whatever you like:
   folding, outline, templates, search-and-replace across files.

3. **Push** — when you are happy, run **Push this page to Confluence** with the note open.
   Or **Push all locally modified pages** to send everything you have changed across a whole
   subscription.

4. **Check** — the notice tells you what happened. If something was refused, it tells you
   why, in a sentence you can act on.

That is it. Sync in the morning, push when you are done.

---

## Ten things every user should know

### 1. Syncing never publishes anything

Pulling is automatic. **Pushing is always something you asked for.** A sync will report that
you have local edits, and it will raise conflicts for you to decide — but it will not send
your text to Confluence on its own. There is no background sync and no auto-save-to-server.

### 2. A brand-new note you write is not published automatically

If you create `My Ideas.md` inside a mirrored folder, it stays a local file. The sync panel
lists it under **Untracked files in the mount** so you know the plugin has seen it and is
leaving it alone. When you actually want it in Confluence, run **Publish this note as a new
Confluence page**.

This is deliberate. A folder you sync is not a drop-box that publishes your drafts.

### 3. Deleting a note does not delete the page

If you delete a mirrored note, the Confluence page is untouched. The next sync lists it in
the panel as an **orphan** with two buttons: **Restore note** (bring it back) or **Delete
page** (really delete it in Confluence). The second one makes you type the page's exact
title first.

### 4. Your frontmatter `tags` become Confluence labels

When you push, the plugin compares your note's `tags` with the labels it last saw and sends
the difference. Add a tag, the page gains a label; remove one, the page loses it.

> **Be careful with this.** It pushes your note's **whole** frontmatter tag list. If you tag
> a work page `todo` to organise your own week, `todo` becomes a label on a corporate page
> that your colleagues can see. Keep personal tags out of the frontmatter of mirrored notes
> — inline `#tags` in the body are not touched, only the `tags:` list in the frontmatter.

A tag Confluence cannot accept as a label is **reported**, not silently dropped, and it never
fails the push — the page's text matters more than its metadata.

### 5. Attachments are only ever uploaded, never deleted

Embed a new image in a note, push, and the file is uploaded to the page. But the plugin will
**never** remove an attachment from Confluence — not even one it uploaded itself, not even
one nothing points at any more. Deleting somebody's file because your local copy of a page
no longer mentions it is exactly the kind of damage this plugin is built not to do.

One consequence worth knowing: if the page already has a file with the same name that this
plugin did not put there, the push is **refused** with a message asking you to rename your
local file. It will not overwrite a file it did not create.

**Write embeds as the full vault path.** `![[EP/_attachments/146743218/diagram.png]]` works;
a bare `![[diagram.png]]` is refused with the exact path to use. Obsidian's autocomplete
sometimes inserts the short form, so this one catches people out.

### 6. Comments come along, but you cannot reply from here

Page comments appear at the bottom of the note in a managed section. It is **read-only** —
regenerated on every sync, so anything you type inside it is lost. Reply in Confluence.

You can turn comments off per subscription (**Sync comments**) or per note by adding
`confluenceComments: false` to that note's frontmatter.

### 7. Moving and renaming works, and the plugin works out who moved what

Rename a note and the Confluence page is renamed on your next push. Drag a note into a
different folder and the page is re-parented. Equally, if someone moves or renames the page
_in Confluence_, your file follows.

But if **both** sides moved the same page since the last sync, the plugin **refuses** and
tells you, rather than picking a winner. Sort it out on one side, then sync.

### 8. Something changed in both places? You choose

You are never silently overwritten and nothing is ever auto-merged. See
[When two people edited the same page](#when-two-people-edited-the-same-page).

### 9. It keeps a backup before overwriting your work

Any time the plugin is about to replace a note you have edited, it copies the old version
into its own state folder first, and keeps it for the number of days you set in settings
(default 14). Those copies live outside your vault, so they never clutter your notes or your
search results. If a backup cannot be written, the destructive write is **cancelled**.

### 10. On Windows, keep your vault near the top of the drive

Windows limits how long a file path can be. Confluence page titles are often long, and
nested pages make long paths. If a page's path would exceed the limit, the plugin refuses to
write it and tells you — rather than letting the operating system fail with something
unreadable.

If you hit it: move your vault closer to the drive root (`C:\Vaults\Work` rather than
`C:\Users\you\OneDrive\Documents\Obsidian\Work\…`), or give the subscription a shorter vault
folder name.

---

## What the grey boxes mean

Confluence has features Markdown simply has no way of writing down: Jira issue lists, page
trees, status badges, and dozens of other macros. The plugin never throws these away and
never guesses at them. It keeps the original exactly as Confluence stored it, and shows you
a **labelled grey box** in its place, naming what it is.

Click **Open in Confluence** on the box to see the real thing. To change it, change it in
Confluence and sync. When you push, the plugin hands Confluence back the identical original,
so preserved content survives your edit untouched.

Small ones appear as **grey pills** in the middle of a sentence. Large ones appear as boxes
on their own.

**A lot of Confluence content that used to be a grey box now displays properly:**

| Confluence thing            | What you see now                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **draw.io diagrams**        | The actual diagram, as a picture. Edit it in Confluence — the drawing tool makes the image.                            |
| **Emoticons** (✅ ❌ ⚠️)    | The matching character, not a grey pill.                                                                               |
| **Complicated tables**      | Real tables, with their pictures and file links showing, even when merged cells mean Markdown cannot express the grid. |
| **Table of contents**       | A real, clickable list of the note's own headings.                                                                     |
| **Child pages**             | A real, clickable list of the child notes beside it.                                                                   |
| **Included pages**          | The included page shown inline, exactly as Confluence shows it.                                                        |
| **Panels, notes, warnings** | Obsidian callouts.                                                                                                     |
| **Task lists**              | Real checkboxes.                                                                                                       |

---

## When a page is read-only

Look at the end of the `confluence:` block in a note's frontmatter:

- **`fidelity: certified`** — this page survived a full round trip. The plugin converted it
  to Markdown, converted it back, and got the original again. **You can edit and push it.**

- **`fidelity: degraded`** — something in the page did not come back identical. The note is
  **read-only**: you can read it, search it and link to it, but push is refused and you are
  offered the page in Confluence instead.

This is not the plugin being fussy. It means: _if I sent your edit back, I could not promise
the rest of the page would survive._ Rather than risk quietly mangling a colleague's work,
it declines. Edit that page in Confluence and sync.

A second, separate check runs before **every** individual push: your edit is converted and
converted back, and if the result does not match what you wrote, the push is blocked and you
are shown the difference. The two checks answer different questions — _can this page ever be
pushed safely_, and _can this particular edit_.

---

## When two people edited the same page

If you changed a note and somebody changed the same page in Confluence since your last sync,
the plugin stops and asks. You get the page title, when it changed, who changed it, and
three choices:

| Choice          | What happens                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep local**  | Your note is published, replacing the Confluence version.                                                                               |
| **Keep remote** | Your note is replaced with the Confluence version. **A backup of yours is kept first.**                                                 |
| **Save both**   | Your note is left exactly as it is, and the Confluence version is written beside it as a new file so you can compare and merge by hand. |

You can also click **Decide later** and the conflict stays listed in the sync panel.

A "Save both" copy is marked in its own frontmatter so the plugin knows it is a comparison
copy and not a page — delete it once you have merged, and the sync panel reminds you it is
there.

---

## Commands

Open the command palette with <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>P</kbd> and type any part
of the name. None of these have a keyboard shortcut by default; assign your own in
**Settings → Hotkeys**.

| Command                                        | What it does                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync all subscriptions**                     | Pulls everything. The one you will use most.                                                                                                                                |
| **Push this page to Confluence**               | Sends the open note's changes.                                                                                                                                              |
| **Push all locally modified pages**            | Sends every changed note, one page at a time.                                                                                                                               |
| **Stop the push in progress**                  | Stops a batch push cleanly, after the page it is on.                                                                                                                        |
| **Pull this page from Confluence**             | Re-fetches just the open note, always, even if nothing changed remotely. Useful after a plugin update.                                                                      |
| **Open this page in Confluence**               | Opens the open note's page in your browser.                                                                                                                                 |
| **Open the sync panel**                        | The sidebar report: conflicts, orphans, untracked files, errors.                                                                                                            |
| **Create a page in Confluence**                | Makes a brand-new page under a parent you choose, and writes its note.                                                                                                      |
| **Publish this note as a new Confluence page** | Takes a note you wrote yourself and creates the page for it.                                                                                                                |
| **Delete this page in Confluence**             | Sends the page to Confluence's trash and removes the note. Needs its exact title typed.                                                                                     |
| **Tidy folder notes**                          | Cleans up folders left behind by pages that no longer have children.                                                                                                        |
| **Check conversion fidelity of a space**       | A diagnostic. Samples a space, converts it without writing anything, and reports how much would come through cleanly. Good for deciding whether a space is worth mirroring. |

---

## Settings

**Settings → Confluence 4 Obsidian.**

### Connections

One per Confluence site. Each has **Test** (check it works), **Spaces** (browse what you can
see), **Edit** and **Remove**.

- **Strict markup** _(per connection, off by default)_ — leave this off. Confluence pages are
  full of invisible leftover markup that renders as nothing: empty spans, stray formatting,
  wrappers from old editors. Normally the plugin drops it, which is what keeps notes
  readable. Turn this on and it keeps every byte instead — which means far more grey boxes
  and much noisier notes. Only worth it if you need byte-for-byte fidelity above
  readability.

### Subscriptions

One per mirrored space or subtree. Each has **Sync now** and **Remove**, and one switch:

- **Sync comments** — whether page comments are written into notes for this subscription.

Removing a subscription stops syncing. It does not delete your files.

### Attachments

- **Maximum attachment size (MB)** _(25 by default)_ — files larger than this are skipped and replaced with a
  link, so one 400 MB video does not stall your sync.
- **Only download referenced attachments** — on by default. Fetches only files the page
  actually shows, not every file ever attached to it. Turn it off if you want everything.

### Safety

- **Allow force push** _(off by default)_ — lets you push a page whose edit failed the
  round-trip check. It asks for typed confirmation every single time. Leave it off unless you
  know exactly what you are overriding.
- **Backup retention (days)** — how long the copies made before destructive writes are kept.
  Default 14.

### Advanced

- **Large subtree warning threshold** _(1 000 pages by default)_ — warns before you subscribe to something enormous.
- **Debug logging** — writes detailed diagnostics to the developer console
  (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>). Tokens are redacted from every line.
  Turn it on when reporting a problem.

---

## Troubleshooting

**"Confluence answered as Anonymous, so it did not accept the token."**
Your token is wrong, expired, or from a different Confluence instance. Some servers do not
reject a bad token outright — they treat you as a guest, which then looks like a permission
problem. Make a fresh token and paste it again, being careful not to clip the ends.

**Test connection fails, or you see nothing but empty results.**
Check the **Base URL** first — this is the most common cause by a wide margin. It must match
your browser's address bar including any path, so `https://wiki.example.com/confluence`, not
`https://wiki.example.com`. No trailing slash. Then check whether you need a VPN.

**"The TLS certificate could not be verified."**
Your Confluence uses a certificate from your company's own authority. Install that
authority's root certificate in your **operating system's** trust store and restart
Obsidian. The plugin deliberately offers no "ignore certificate errors" switch, because the
only thing such a setting reliably achieves is making interception invisible.

**"Your Confluence account does not have permission for this action."**
Confluence's own explanation is appended as _Confluence said: …_, which usually names the
problem exactly. For creating a page it is normally a missing **Add Page** permission in
that space, or a restriction on the parent page. Check by trying the same thing in your
browser — if you cannot do it there, that is the answer.

**A page is read-only and I cannot push it.**
It is marked `fidelity: degraded`. See [When a page is read-only](#when-a-page-is-read-only).
Edit it in Confluence instead.

**A push was refused and I was shown a difference.**
Your edit could not be turned back into Confluence's format without changing something else.
Most often something was typed over one of the invisible markers that hold preserved content
together — try undoing your last edit near a grey box or pill. If the difference looks
cosmetic and you are certain, **Allow force push** exists in settings, off by default and
confirmed each time.

**A new comment has not appeared.**
Comments arrive with the page. Every sync asks the server which pages have new comments, so a
comment on an otherwise-untouched page does come through — but not if comments are off for
that subscription, and not if you have unpushed edits in that note. **Pull this page from
Confluence** always fetches them.

**A note I created has not appeared in Confluence.**
That is intended. Run **Publish this note as a new Confluence page**.

**"Refused to write … past the 240-character limit."**
The path is too long for Windows. See point 10 in
[Ten things every user should know](#ten-things-every-user-should-know).

**Nothing above helps.**
Turn on **Debug logging**, reproduce the problem with the developer console open
(<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>), and
[open an issue](https://github.com/codewithelvin/confluence-for-obsidian/issues) with what
the console said. Tokens are never logged, so the output is safe to paste — but do read it
over for page titles you would rather not share.

---

## What it deliberately will not do

These are the product, not gaps in it. Every one of them exists because the alternative can
damage a shared corporate wiki quietly.

- **A sync never publishes.** Pushing is always a command you ran.
- **A sync never creates a page.** New local notes are reported, not published.
- **Deleting a note never deletes a page.** That takes an explicit action and a typed title.
- **A page it cannot round-trip cannot be pushed.** Not with a warning, not with a tickbox —
  the command declines and offers Confluence instead.
- **An edit that does not round-trip is not sent.** Force push exists, is off by default, and
  demands typed confirmation each time.
- **It never deletes an attachment from Confluence.** Uploads only.
- **It never replaces an attachment it did not upload.** It refuses and asks you to rename.
- **Conflicts are never merged automatically.** Three explicit choices, per page, with a diff.
- **Nothing is written outside your subscription's folder.** Backups and internal state live
  in the plugin's own directory, never in your notes.
- **No page is ever half-written.** If a write fails, you get an error, not a truncated file.

---

## Known limits

Honest list, so nothing surprises you later:

- **One Confluence version verified.** Built and tested against Data Center 7.19.6. Other
  7.x and 8.x versions are expected to work but have not been proven.
- **Macros are preserved, not rendered.** Showing live Jira results or a page tree would mean
  asking Confluence to render the page, which is a different kind of plugin.
- **Comments are read-only.** They can be read, not written.
- **No background sync.** Syncing is always a command. Automatic syncing multiplies the ways
  two people can collide.
- **No three-way merge.** Conflicts are resolved by choosing, not by merging.
- **Blog posts, whiteboards and databases are out of scope.** Pages only.
- **Conversion runs on the main thread.** A single enormous page can briefly make Obsidian
  unresponsive while it converts.
- **Confluence Cloud will not be supported.** Different API, different content format,
  different product.

---

## For developers

```bash
npm install
npm run dev       # watch build
npm run verify    # typecheck + lint + layer boundaries + format + tests with coverage
npm run build     # production bundle
npm run install:test   # copy the build into the local test vault
```

The test suite is 1 656 tests across 60 files, at 96.9% line and 91.8% branch coverage.
`npm run verify` must be green before anything is called done — it is also the entirety of
what CI runs, so a green local run and a green build cannot disagree.

### Cutting a release

Releases are built by GitHub Actions. You never upload a file by hand.

```bash
npm version 0.1.0     # updates manifest.json and versions.json, commits, tags
git push origin main --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which verifies, builds, and publishes a
release carrying `main.js`, `manifest.json`, `styles.css` and a ready-to-unzip
`confluence-dc-connector-<version>.zip`.

Two guards run **before** anything is built, because both failures are invisible until a user
hits them:

- the tag must equal `manifest.json`'s `version` — tagging `1.0.0` while the manifest says
  `0.0.1` publishes a release every installer reads as the wrong version;
- `versions.json` must have an entry for it, which is how Obsidian decides whether an older
  app version may install this build.

`npm version` sets both, which is why it is the documented route. Only semver tags trigger the
workflow, so a `wip` or `before-refactor` tag is ignored; a `0.x` or prerelease tag is
published as a **prerelease**, which is what BRAT's beta setting looks for.

### Architecture rules

Enforced by ESLint — a violation fails the build:

- **Layer boundaries.** Dependencies point downward only: UI → Commands → Orchestration →
  Domain → Gateways. No upward or sideways imports.
- **One door per outside world.** All Confluence HTTP goes through `ConfluenceClient`; all
  vault I/O goes through `VaultGateway`.
- **Converters are pure.** No I/O, no clock, no randomness, so conversion is reproducible and
  testable.
- **`innerHTML`, `outerHTML` and `insertAdjacentHTML` are banned.** Confluence content is
  untrusted input and is never handed to an HTML parser.
- **300 lines per file, 50 per function.** The limit is design review, not bookkeeping —
  crossing it usually means there is a seam worth finding.
- **No new runtime dependency without explicit approval.**

The full specification lives outside this repository and is the authority on all behaviour
described here.

---

## Licence

MIT © Elvin Huseynov
