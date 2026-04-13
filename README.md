# TickTick Deadline Sync (Obsidian Plugin)

Rule-based Obsidian -> TickTick sync for frontmatter deadlines.

This is a one-way sync where Obsidian remains source of truth.

## What changed in v0.2.0

- Modularized codebase (`src/constants.ts`, `defaults.ts`, `oauth.ts`, `ticktickClient.ts`, `sync.ts`, `ui/*`).
- Added scenario-based sync rules (multiple profiles in one vault).
- Added include/exclude tags per rule.
- Added due field fallback list per rule (`due, deadline, exam_date`, etc).
- Added sync mode per rule:
  - `upsert` (create + update)
  - `create_only` (only create new tasks)
- Added configurable completion keywords per rule.
- Added title/content templates with token support.
- Improved setup UX with quick setup status block and safer copy/default controls.

## Core behavior

- Scans markdown notes with frontmatter.
- Rule determines whether a note should sync (tag include/exclude).
- Reads due date from first non-empty field in each rule's `dueFields` list.
- Creates or updates TickTick task (based on rule sync mode + task id field).
- Writes tracking fields back into frontmatter:
  - task id field (default `ticktick_task_id`)
  - project id field (default `ticktick_project_id`)
  - synced-at field (default `ticktick_synced_at`)
- Optionally marks TickTick task complete when status matches completion keywords.

## Requirements

- Obsidian 1.5+
- TickTick OpenAPI app credentials
  - https://developer.ticktick.com/manage

## Installation (local build)

1) Build plugin

```bash
npm install
npm run check
npm run build
```

2) Copy files into vault plugin folder:

`<vault>/.obsidian/plugins/ticktick-university-sync/`

Required files:
- `main.js`
- `manifest.json`
- `versions.json`

Optional:
- `styles.css`

3) Enable in Obsidian Community Plugins.

## Quick setup flow

In plugin settings:

1. Enter Client ID + Client Secret.
2. Set Redirect URI (default recommended: `https://localhost/`).
3. Click `Open OAuth URL` and authorize.
4. Click `Exchange auth code/URL` and paste either:
   - full redirect URL, or
   - code value only.
5. Click `Test API connection`.
6. Configure at least one rule and discover/set its target project.
7. Run `Sync now` (use `Dry run` first if you want preview-only behavior).

## Rule configuration

Each rule controls one scenario (university, work, personal, etc):

- `enabled`
- `tagsAny` (include if note has any tag)
- `excludeTagsAny` (skip if note has any tag)
- `dueFields` (ordered fallback list)
- frontmatter keys:
  - `statusField`
  - `classField`
  - `taskIdField`
  - `projectIdField`
  - `syncedAtField`
- target project:
  - `targetProjectName`
  - `targetProjectId` (optional fixed)
- behavior:
  - `syncMode`: `upsert` or `create_only`
  - `markCompletedInTickTick`
  - `includeCompletedWithoutTaskId`
  - `completedKeywords`
- rendering:
  - `titleTemplate`
  - `contentTemplate`

Supported template tokens:
- `{{noteTitle}}`
- `{{filePath}}`
- `{{class}}`
- `{{obsidianLink}}`
- `{{ruleName}}`
- `{{dueRaw}}`

Use `\n` in template fields for line breaks.

## Due format support

- `YYYY-MM-DD` -> all-day task
- `YYYY-MM-DDTHH:mm`
- `YYYY-MM-DDTHH:mm:ss`
- timezone suffix optional: `Z`, `+HH:mm`, `+HHMM`

## Safety

- `Dry run` skips create/update/complete and frontmatter writes.
- Auto-sync disabled when interval is `0`.
- Token refresh is automatic when expired.

## Legacy settings migration

v0.1.0 settings are migrated into one default rule automatically on load.

## Commands

- Sync deadlines to TickTick now
- Open TickTick OAuth authorization URL
- Exchange TickTick auth code/URL
- Test TickTick API connection
- Discover TickTick projects and auto-select target
