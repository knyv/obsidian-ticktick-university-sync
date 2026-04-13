# TickTick Flow Sync (Obsidian Plugin)

Modular, rule-based Obsidian -> TickTick sync for frontmatter deadlines/tasks.

One-way sync: Obsidian is the source of truth.

## Quick start (first-time users)

If this is your first setup, do this in order:

1) Open plugin settings in Obsidian.
2) In "Quick setup wizard", click "Open TickTick Developer Apps".
3) Create or edit your TickTick app:
   - Redirect URI must be EXACTLY: `https://localhost/`
4) Copy Client ID + Client Secret into plugin settings.
5) Click "Open OAuth URL" and approve in browser.
6) After redirect, copy the full URL from browser address bar.
7) Back in plugin settings:
   - click "Exchange from Clipboard" (fast path), or
   - click "Exchange" and paste URL/code manually.
8) Click "Test API connection".
9) Click "Load project list".
10) Add a rule and pick a target project from dropdown.
11) Run `Dry run` first, then `Sync now`.

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
- at least one due field in `Due fields` is non-empty.

Due field behavior:
- `Due fields` is ordered fallback, e.g. `due, deadline, exam_date`
- first non-empty key wins.

Sync behavior:
- `upsert`: create new + update existing tasks
- `create_only`: only create new tasks

Use one rule per context:
- University
- Work
- Personal

## Better TickTick formatting

Per rule you can customize:
- `Task title template`
- `Task content template`
- `Task description template (desc)`

Built-in template tokens:
- `{{noteTitle}}` = note filename without `.md`
- `{{filePath}}` = vault-relative note path
- `{{class}}` = class property value
- `{{obsidianLink}}` = obsidian deep link to note
- `{{ruleName}}` = current sync rule name
- `{{dueRaw}}` = raw due property value
- `{{duePretty}}` = formatted due date/time text
- `{{status}}` = status property value
- `{{tags}}` = tags as comma-separated text
- `{{projectName}}` = selected TickTick project name

Custom property tokens:
- If "Template token mode" is enabled, any frontmatter property can be used as `{{propertyName}}`
  (example: `{{priority}}`, `{{teacher}}`, `{{module}}`).

Line breaks:
- Press Enter in template textareas (recommended)
- Literal `\n` is also supported

Formatting presets included:
- Clean
- Detailed

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

## Commands

- Sync notes to TickTick now
- Beginner path: open TickTick Developer Apps (step 1)
- Beginner path: open TickTick OAuth URL (step 4)
- Beginner path: exchange auth from clipboard (step 6)
- Beginner path: exchange auth code/URL (manual alt)
- Connection check: test TickTick API
- Projects: load TickTick project list
- Projects: auto-select target project for first rule
