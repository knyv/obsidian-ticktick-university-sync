# TickTick University Sync (Obsidian Plugin)

Syncs university assignment/exam deadlines from Obsidian note frontmatter to TickTick using TickTick OpenAPI.

## What it does

- Scans notes with tags:
  - `university/assignments`
  - `university/exams`
- Reads frontmatter fields (configurable):
  - `due` (required)
  - `status`
  - `class`
- Creates or updates a TickTick task per note.
- Stores tracking fields back to note frontmatter:
  - `ticktick_task_id`
  - `ticktick_project_id`
  - `ticktick_synced_at`
- If note status indicates completion, marks task complete in TickTick.

## Requirements

- Obsidian 1.5+
- TickTick OpenAPI app (Client ID + Client Secret)
  - https://developer.ticktick.com/manage

## Setup

1. Build plugin

```bash
npm install
npm run build
```

2. Install plugin in vault

Copy these files into:
`<your-vault>/.obsidian/plugins/ticktick-university-sync/`

- `main.js`
- `manifest.json`
- `styles.css` (optional)
- `versions.json`

3. Enable plugin in Obsidian Community Plugins.

4. Configure settings:

- Client ID
- Client Secret
- Redirect URI (must match TickTick app settings)
- Tag keys + field keys (defaults work with your current vault)

5. OAuth connect flow:

- Click `Open OAuth URL`
- Authorize in browser
- Copy redirect URL (or code)
- Click `Exchange auth code/URL`

6. Click `Discover projects + auto-select` or manually set `TickTick target project ID`.

7. Run `Sync now`.

## Default field mapping

- Assignment tag: `university/assignments`
- Exam tag: `university/exams`
- Due field: `due`
- Status field: `status`
- Class field: `class`

Tracking fields written to frontmatter:

- `ticktick_task_id`
- `ticktick_project_id`
- `ticktick_synced_at`

## Due format support

- `YYYY-MM-DD` -> all-day task
- `YYYY-MM-DDTHH:mm`
- `YYYY-MM-DDTHH:mm:ss`
- Optional timezone suffix supported (`Z`, `+HH:mm`, `+HHMM`)

## Safety

- `Dry run` toggle scans/evaluates without writing or calling TickTick.
- Auto-sync interval can be disabled with `0`.

## Notes

- This plugin is one-way sync (Obsidian -> TickTick) by design.
- Obsidian is the source of truth.
