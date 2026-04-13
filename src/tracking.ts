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

async function writeTrackingMap(app: App, settings: TickTickUniversitySyncSettings, map: TrackingMap): Promise<void> {
  const path = resolveTrackingPath(settings);
  const file = app.vault.getAbstractFileByPath(path);
  const content = JSON.stringify(map, null, 2);

  if (file) {
    await app.vault.modify(file as never, content);
  } else {
    const parts = path.split('/');
    parts.pop();
    const folder = parts.join('/');
    if (folder) {
      await app.vault.createFolder(folder).catch(() => undefined);
    }
    await app.vault.create(path, content);
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
