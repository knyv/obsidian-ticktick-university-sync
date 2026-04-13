import { App, normalizePath } from 'obsidian';
import { SyncCandidate, TickTickUniversitySyncSettings, TrackingEntry, TrackingMap } from './types';

function resolveTrackingPath(settings: TickTickUniversitySyncSettings): string {
  return normalizePath(settings.localTrackingFile || '.obsidian/plugins/ticktick-flow-sync/tracking.json');
}

function ruleScopedKey(candidate: SyncCandidate): string {
  return `${candidate.rule.id}::${candidate.file.path}`;
}

async function readTrackingMap(app: App, settings: TickTickUniversitySyncSettings): Promise<TrackingMap> {
  const path = resolveTrackingPath(settings);
  const adapter = app.vault.adapter;

  const exists = await adapter.exists(path);
  if (!exists) return {};

  let content = '';
  try {
    content = await adapter.read(path);
  } catch {
    return {};
  }

  if (!content.trim()) return {};

  try {
    const parsed = JSON.parse(content) as TrackingMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureFolderPath(app: App, folderPath: string): Promise<void> {
  if (!folderPath) return;
  const adapter = app.vault.adapter;
  const parts = folderPath.split('/').filter(Boolean);
  let current = '';

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      const exists = await adapter.exists(current);
      if (!exists) await adapter.mkdir(current);
    } catch {
      // already created by another process or path race
    }
  }
}

async function writeTrackingMap(app: App, settings: TickTickUniversitySyncSettings, map: TrackingMap): Promise<void> {
  const path = resolveTrackingPath(settings);
  const content = JSON.stringify(map, null, 2);

  const parts = path.split('/');
  parts.pop();
  const folder = parts.join('/');
  await ensureFolderPath(app, folder);

  await app.vault.adapter.write(path, content);
}

export async function getTrackingForCandidate(
  app: App,
  settings: TickTickUniversitySyncSettings,
  candidate: SyncCandidate,
  opts?: { forceLocal?: boolean },
): Promise<TrackingEntry | undefined> {
  if (settings.trackingMode !== 'local_json' && !opts?.forceLocal) return undefined;
  const map = await readTrackingMap(app, settings);
  const scoped = map[ruleScopedKey(candidate)];
  if (scoped) return scoped;

  const legacy = map[candidate.file.path];
  if (!legacy) return undefined;

  // Safety: only trust legacy file-level key if it points to this rule's target project.
  if (candidate.rule.targetProjectId && legacy.projectId && legacy.projectId !== candidate.rule.targetProjectId) {
    return undefined;
  }

  return legacy;
}

export async function setTrackingForCandidate(
  app: App,
  settings: TickTickUniversitySyncSettings,
  candidate: SyncCandidate,
  entry: TrackingEntry,
  opts?: { forceLocal?: boolean },
): Promise<void> {
  if (settings.trackingMode !== 'local_json' && !opts?.forceLocal) return;
  const map = await readTrackingMap(app, settings);

  // Always keep rule-scoped key authoritative.
  map[ruleScopedKey(candidate)] = entry;

  // Keep legacy file key only when it is empty or already same project.
  const legacy = map[candidate.file.path];
  if (!legacy || !legacy.projectId || legacy.projectId === entry.projectId) {
    map[candidate.file.path] = entry;
  }

  await writeTrackingMap(app, settings, map);
}
