# TickTick Flow Sync (Obsidian Plugin)

Modular, rule-based Obsidian -> TickTick sync for frontmatter deadlines/tasks.

One-way sync: Obsidian is the source of truth.

## Quick start (first-time users)

If this is your first setup, do this in order:

1) Open plugin settings in Obsidian.
2) In Setup pane, click "Open TickTick Developer Apps".
3) Create or edit your TickTick app:
   - Redirect URI must be EXACTLY: `https://localhost/`
4) Copy Client ID + Client Secret into plugin settings.
5) Click "Open OAuth URL" and approve in browser.
6) After redirect, copy the full URL from browser address bar.
7) Back in Setup pane:
   - click "Exchange from Clipboard" (fast path), or
   - click "Manual Exchange" and paste URL/code manually.
8) Click "Load + test projects".
9) Go to Rules pane, add a rule, and select target project.
10) Run `Sync now`.

## OAuth notes (important)

- Redirect URI mismatch is the #1 setup failure.
- Use exactly `https://localhost/` in BOTH:
  - TickTick developer app page
  - plugin Redirect URI field
- Keep trailing slash.

## Rule model (how sync decides what to include)

A note is synced by a rule when:
- it has ANY tag in `Include tags`, and
- it has NONE of the tags in `Exclude tags`, and
- due field requirement is satisfied:
  - default: requires at least one non-empty due property
  - optional advanced mode: disable due requirement for general task sync

Due field behavior:
- `Due fields` is ordered fallback, e.g. `due, deadline, exam_date`
- first non-empty key wins.

Sync behavior:
- `upsert`: create new + update existing tasks
- `create_only`: only create new tasks

Use one rule per context:
- Deadlines
- Work
- Personal
- General tasks (optional due date)

## Better TickTick formatting

Per rule you can customize:
- `Task title template`
- `Task content template`
- `Task description template (desc)`

Built-in template tokens:
- `{{noteTitle}}` = note filename without `.md`
- `{{filePath}}` = vault-relative note path
- `{{class}}` = class property value
- `{{obsidianLink}}` = raw obsidian deep link (opens only if client/device supports `obsidian://`)
- `{{obsidianMdLink}}` = Markdown link wrapper around obsidian deep link (recommended in content/desc)
- `{{ruleName}}` = current sync rule name
- `{{dueRaw}}` = raw due property value
- `{{duePretty}}` = formatted due date/time text
- `{{status}}` = status property value
- `{{tags}}` = note tags as comma-separated text
- `{{projectName}}` = selected TickTick project name

Custom property tokens:
- If "Template token mode" is enabled, any frontmatter property can be used as `{{propertyName}}`
  (example: `{{priority}}`, `{{teacher}}`, `{{module}}`).

Line breaks:
- Press Enter in template textareas (recommended)
- Literal `\n` is also supported

Non-redundant default strategy:
- Let TickTick own due date/status/project metadata in native fields
- Keep content/description templates minimal (for note link/path/context only)

Tag mapping to TickTick:
- Each rule now supports TickTick tags mapping:
  - `TickTick tags source`: all note tags OR only rule include-tags
  - `TickTick tags field`: optional frontmatter field (default `ticktick_tags`)
- Example frontmatter:
  - `ticktick_tags: [urgent, reading]`
  - or `ticktick_tags: urgent, reading`

Formatting presets included:
- Minimal
- Notes-focused

Per-rule sync filters:
- Which tasks to sync: All / Only new / Only existing
- Due-date window: All due dates / Only already due (overdue) / Only upcoming

Startup/performance UX:
- Optional delayed project preload at startup (non-blocking + idle-time)
- Optional delayed startup sync (runs only when already connected)
- Simple mode on by default to keep settings light

Task source marker:
- Optional marker appended to task description (default: "Created by TickTick Flow Sync")

## Tracking mode (note metadata vs local file)

Choose in settings:

1) `frontmatter` (default)
- writes task IDs into note properties
- easiest to inspect/debug and most portable

2) `local_json`
- keeps note metadata clean
- stores mapping in plugin JSON (default path):
  `.obsidian/plugins/ticktick-flow-sync/tracking.json`

## Install from source

1) Build

```bash
npm install
npm run check
npm run build
```

2) Copy files to:

`<vault>/.obsidian/plugins/ticktick-flow-sync/`

Required:
- `main.js`
- `manifest.json`
- `versions.json`

Optional:
- `styles.css`

3) Enable plugin in Obsidian community plugins.

## Due format support

- `YYYY-MM-DD` (all-day)
- `YYYY-MM-DDTHH:mm`
- `YYYY-MM-DDTHH:mm:ss`
- optional TZ suffix: `Z`, `+HH:mm`, `+HHMM`

Settings panes:
- Setup: OAuth, connection test, project preload
- Rules: add/edit rules, apply custom presets, save exact rule as preset
  - include-tags editor no longer force-refreshes on every keystroke (fixes focus loss / one-letter typing bug)
  - each rule now has inline quick summary + readiness chip (`Ready to sync` / `Needs setup` / `Rule disabled`)
  - each rule shows explicit missing-state text in quick setup (`Missing: include tags`, `Missing: target project`)
  - each rule includes a `Fix this rule` quick action when project is missing
  - matching details are collapsed by default in simple mode (`Matching` button)
  - formatting controls are collapsed by default in simple mode (`Formatting` button)
  - advanced per-rule options are hidden behind `Advanced` button in `Rule actions`
  - no-rules state now has guided CTAs (`+ Create first rule`, `+ Add Deadlines rule`)

Formatting behavior update:
- `contentTemplate` is now the primary recommended field for task details/links
- `descTemplate` is treated as legacy/optional (hidden in simple mode unless advanced is open)

TickTick tags mapping:
- Existing options retained:
  - source from note tags OR include-tags
  - optional frontmatter tags field (`ticktick_tags`)
- New options:
  - fixed per-rule TickTick tags (`Fixed TickTick tags`) always appended to matching tasks
  - `Suggest` button (best-effort) pulls known tags from current TickTick tasks and appends up to 8 unseen tags
- Advanced: sync automation, tracking mode, token mode, performance, reset

## Commands

- Sync notes to TickTick now
- Beginner path: open TickTick Developer Apps (step 1)
- Beginner path: open TickTick OAuth URL (step 4)
- Beginner path: exchange auth from clipboard (step 6)
- Beginner path: exchange auth code/URL (manual alt)
- Connection check: test TickTick API
- Projects: load TickTick project list
- Projects: validate and refresh selected target projects
