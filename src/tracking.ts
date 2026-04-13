import { App, normalizePath } from 'obsidian';
import { SyncCandidate, TickTickUniversitySyncSettings, TrackingEntry, TrackingMap } from './types';

function resolveTrackingPath(settings: TickTickUniversitySyncSettings): string {
  return normalizePath(settings.localTrackingFile || '.obsidian/plugins/ticktick-university-sync/tracking.json');
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
): Promise<TrackingEntry | undefined> {
  if (settings.trackingMode !== 'local_json') return undefined;
  const map = await readTrackingMap(app, settings);
  return map[candidate.file.path];
}

export async function setTrackingForCandidate(
  app: App,
  settings: TickTickUniversitySyncSettings,
  candidate: SyncCandidate,
  entry: TrackingEntry,
): Promise<void> {
  if (settings.trackingMode !== 'local_json') return;
  const map = await readTrackingMap(app, settings);
  map[candidate.file.path] = entry;
  await writeTrackingMap(app, settings, map);
}
