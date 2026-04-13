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
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) return {};

  const content = await app.vault.read(file as never);
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
  const parts = folderPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // another sync/process may have created it meanwhile
      }
    }
  }
}

async function writeTrackingMap(app: App, settings: TickTickUniversitySyncSettings, map: TrackingMap): Promise<void> {
  const path = resolveTrackingPath(settings);
  const content = JSON.stringify(map, null, 2);

  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) {
    await app.vault.modify(existing as never, content);
    return;
  }

  const parts = path.split('/');
  parts.pop();
  const folder = parts.join('/');
  await ensureFolderPath(app, folder);

  try {
    await app.vault.create(path, content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('already exists')) {
      const again = app.vault.getAbstractFileByPath(path);
      if (again) {
        await app.vault.modify(again as never, content);
        return;
      }
    }
    throw e;
  }
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
  return map[candidate.file.path];
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
  map[candidate.file.path] = entry;
  map[ruleScopedKey(candidate)] = entry;
  await writeTrackingMap(app, settings, map);
}
