# TickTick Flow Sync (Obsidian Plugin)

Modular, rule-based Obsidian -> TickTick sync for frontmatter deadlines/tasks.

One-way sync: Obsidian is the source of truth.

## New in v0.3.0

- Better TickTick formatting control:
  - `titleTemplate`
  - `contentTemplate`
  - `descTemplate`
- More template tokens:
  - `{{noteTitle}}`, `{{filePath}}`, `{{class}}`, `{{obsidianLink}}`, `{{ruleName}}`, `{{dueRaw}}`
  - `{{duePretty}}`, `{{status}}`, `{{tags}}`, `{{projectName}}`
- Formatting presets in settings (Clean / Detailed).
- Project dropdown selector per rule (after loading project list).
- Optional local tracking mode:
  - `frontmatter` (existing behavior)
  - `local_json` (store task mapping in local plugin JSON instead of note properties)

## Should tracking be local JSON or frontmatter?

Short answer: both are useful, so plugin now supports both.

- `frontmatter` (default):
  - Pros: transparent in notes, portable, easy to inspect/debug.
  - Cons: adds technical properties to note metadata.
- `local_json`:
  - Pros: clean note frontmatter, no TickTick IDs inside notes.
  - Cons: mapping is local plugin state (if file missing, re-linking relies on title/create flow).

Recommended:
- Use `frontmatter` if you want reliability/transparency across devices/repo.
- Use `local_json` if you prioritize clean note properties and accept local-state dependency.

## Core behavior

- Scans markdown notes with frontmatter.
- Rules decide inclusion (include/exclude tags).
- Due date from first non-empty field in `dueFields` order.
- Creates/updates TickTick tasks by rule `syncMode`.
- Optional completion sync by status keywords.
- Tracking:
  - `frontmatter`: writes IDs into configured frontmatter fields.
  - `local_json`: writes mapping to configured JSON file path.

## Rule settings

Each rule can configure:

- include/exclude tags
- due field fallback list
- field mappings (`status`, `class`, tracking fields)
- target project (name/id + dropdown selection)
- sync mode (`upsert` or `create_only`)
- completion keywords and completion behavior
- title/content/desc templates

## Setup

1) Build

```bash
npm install
npm run check
npm run build
```

2) Install into vault plugin folder:

`<vault>/.obsidian/plugins/ticktick-flow-sync/`

Copy:
- `main.js`
- `manifest.json`
- `versions.json`
- `styles.css` (optional)

3) Enable plugin in Obsidian.

4) In settings:
- set Client ID / Secret
- set Redirect URI (default `https://localhost/`)
- OAuth connect
- test API connection
- load project list (for dropdowns)
- configure rules
- choose tracking mode
- run dry-run, then real sync

## Due format support

- `YYYY-MM-DD` (all-day)
- `YYYY-MM-DDTHH:mm`
- `YYYY-MM-DDTHH:mm:ss`
- optional TZ suffix: `Z`, `+HH:mm`, `+HHMM`

## Commands

- Sync deadlines to TickTick now
- Open TickTick OAuth authorization URL
- Exchange TickTick auth code/URL
- Test TickTick API connection
- Discover TickTick projects and auto-select target
