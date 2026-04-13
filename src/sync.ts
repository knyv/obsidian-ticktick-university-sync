import { App, TFile } from 'obsidian';
import { parseDueToTickTick } from './datetime';
import { TickTickClient } from './ticktickClient';
import {
  SyncCandidate,
  SyncRule,
  SyncSummary,
  TickTickTaskPayload,
  TickTickUniversitySyncSettings,
  TrackingEntry,
  TrackingMode,
} from './types';
import { firstNonEmptyField, normalizeTag, prettyDue, renderTemplate, toStringArray } from './utils';

export type TrackingProvider = {
  read: (candidate: SyncCandidate) => Promise<TrackingEntry | undefined>;
  write: (candidate: SyncCandidate, entry: TrackingEntry) => Promise<void>;
};

type ExistingTaskRef = {
  taskId: string;
  projectId?: string;
};

function isCompletedStatus(statusRaw: unknown, keywords: string[]): boolean {
  const arr = toStringArray(statusRaw).map((s) => s.toLowerCase());
  const scalar = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : '';
  const joined = [...arr, scalar].join(' ');
  return keywords.some((k) => joined.includes(k.toLowerCase()));
}

function getObsidianDeepLink(app: App, file: TFile): string {
  const vaultName = app.vault.getName();
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.path)}`;
}

function getObsidianMarkdownLink(app: App, file: TFile): string {
  const deep = getObsidianDeepLink(app, file);
  return `[${file.basename}](${deep})`;
}

function parseDueForCompare(dueRaw: string): Date | null {
  const raw = dueRaw.trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map((x) => Number(x));
    return new Date(y, m - 1, d, 23, 59, 59, 999);
  }

  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function matchesRule(tags: string[], rule: SyncRule): boolean {
  const normalizedTags = tags.map(normalizeTag);
  const include = rule.tagsAny.map(normalizeTag);
  const exclude = rule.excludeTagsAny.map(normalizeTag);

  const includeHit = include.length === 0 ? false : include.some((tag) => normalizedTags.includes(tag));
  const excludeHit = exclude.some((tag) => normalizedTags.includes(tag));

  return includeHit && !excludeHit;
}

export async function collectCandidates(app: App, settings: TickTickUniversitySyncSettings): Promise<SyncCandidate[]> {
  const candidates: SyncCandidate[] = [];
  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) continue;

    const tags = toStringArray(fm['tags']).map(normalizeTag);

    for (const rule of settings.rules) {
      if (!rule.enabled) continue;
      if (!matchesRule(tags, rule)) continue;

      const dueRaw = firstNonEmptyField(fm, rule.dueFields);
      if (!dueRaw && rule.requireDueDate !== false) continue;

      const classNames = toStringArray(fm[rule.classField]);
      const statusRaw = fm[rule.statusField];
      const taskId = String(fm[rule.taskIdField] ?? '').trim() || undefined;
      const projectId = String(fm[rule.projectIdField] ?? '').trim() || undefined;

      candidates.push({
        file,
        frontmatter: fm,
        rule,
        dueRaw: dueRaw || '',
        tags,
        classNames,
        statusRaw,
        taskId,
        projectId,
      });
    }
  }

  return candidates;
}

function collectTickTickTags(candidate: SyncCandidate): string[] {
  // Obsidian note tags from frontmatter are the only dynamic source.
  // Rule include-tags are for matching only and are not copied as TickTick tags.
  const fromObsidianNote =
    candidate.rule.tagSourceMode === 'all_note_tags'
      ? candidate.tags.map(normalizeTag).filter(Boolean)
      : [];

  const extra = toStringArray(candidate.frontmatter[candidate.rule.ticktickTagsField || 'ticktick_tags'])
    .map(normalizeTag)
    .filter(Boolean);

  const fixed = (candidate.rule.fixedTickTickTags || []).map(normalizeTag).filter(Boolean);

  if (candidate.rule.ticktickTagAssignmentMode === 'rule_only') {
    return Array.from(new Set(fixed));
  }

  const merged = Array.from(new Set([...fromObsidianNote, ...extra, ...fixed]));
  return merged;
}

function shouldSyncByDueWindow(dueRaw: string, mode: SyncRule['dueWindowMode']): boolean {
  const dueMode = mode || 'all';
  if (dueMode === 'all') return true;

  const dueAt = parseDueForCompare(dueRaw);
  if (!dueAt) return true;

  const now = new Date();
  if (dueMode === 'overdue_only') return dueAt.getTime() < now.getTime();
  if (dueMode === 'not_overdue_only') return dueAt.getTime() >= now.getTime();
  return true;
}

function pickExistingTaskRef(
  candidate: SyncCandidate,
  tracked: TrackingEntry | undefined,
  trackingMode: TrackingMode,
): ExistingTaskRef | undefined {
  const fmTaskId = candidate.taskId?.trim();
  const fmProjectId = candidate.projectId?.trim();
  const localTaskId = tracked?.taskId?.trim();
  const localProjectId = tracked?.projectId?.trim();

  if (trackingMode === 'frontmatter') {
    if (fmTaskId) return { taskId: fmTaskId, projectId: fmProjectId || localProjectId };
    if (localTaskId) return { taskId: localTaskId, projectId: localProjectId || fmProjectId };
    return undefined;
  }

  if (localTaskId) return { taskId: localTaskId, projectId: localProjectId || fmProjectId };
  if (fmTaskId) return { taskId: fmTaskId, projectId: fmProjectId || localProjectId };
  return undefined;
}

function buildTaskPayload(
  app: App,
  candidate: SyncCandidate,
  settings: TickTickUniversitySyncSettings,
  projectId: string,
  projectName: string,
  existingId?: string,
): TickTickTaskPayload {
  const hasDue = Boolean(candidate.dueRaw?.trim());
  const due = hasDue ? parseDueToTickTick(candidate.dueRaw) : undefined;
  const classText = candidate.classNames.length ? candidate.classNames.join(', ') : '(not set)';
  const noteLink = getObsidianDeepLink(app, candidate.file);
  const noteMdLink = getObsidianMarkdownLink(app, candidate.file);
  const statusText = toStringArray(candidate.statusRaw).join(', ') || String(candidate.statusRaw ?? '').trim();
  const tagsText = candidate.tags.join(', ');
  const ticktickTags = collectTickTickTags(candidate);

  const tokens: Record<string, string> = {
    noteTitle: candidate.file.basename,
    filePath: candidate.file.path,
    class: classText,
    obsidianLink: noteLink,
    obsidianMdLink: noteMdLink,
    ruleName: candidate.rule.name,
    dueRaw: candidate.dueRaw,
    duePretty: prettyDue(candidate.dueRaw),
    status: statusText || '(not set)',
    tags: tagsText || '(none)',
    projectName: projectName || '(not set)',
  };

  if (settings.allowAllPropertyTokens) {
    for (const [key, value] of Object.entries(candidate.frontmatter)) {
      if (tokens[key] !== undefined) continue;
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        tokens[key] = value.map((x) => String(x)).join(', ');
      } else if (typeof value === 'object') {
        tokens[key] = JSON.stringify(value);
      } else {
        tokens[key] = String(value);
      }
    }
  }

  const title = renderTemplate(candidate.rule.titleTemplate, tokens).trim();

  const content = renderTemplate(candidate.rule.contentTemplate, tokens)
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();

  const desc = renderTemplate(candidate.rule.descTemplate || '', tokens)
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();

  const sourceMarker = settings.addSourceMarker ? settings.sourceMarkerText.trim() : '';
  const mergedDesc = [desc, sourceMarker].filter(Boolean).join('\n\n');

  return {
    id: existingId,
    projectId,
    title: title || candidate.file.basename,
    content,
    desc: mergedDesc || undefined,
    tags: ticktickTags.length ? ticktickTags : undefined,
    isAllDay: due?.isAllDay,
    startDate: due?.startDate,
    dueDate: due?.dueDate,
    timeZone: due?.timeZone,
    status: isCompletedStatus(candidate.statusRaw, candidate.rule.completedKeywords) ? 2 : 0,
  };
}

async function updateFrontmatterTracking(
  app: App,
  candidate: SyncCandidate,
  taskId: string,
  projectId: string,
): Promise<void> {
  await app.fileManager.processFrontMatter(candidate.file, (fm) => {
    (fm as Record<string, unknown>)[candidate.rule.taskIdField] = taskId;
    (fm as Record<string, unknown>)[candidate.rule.projectIdField] = projectId;
    (fm as Record<string, unknown>)[candidate.rule.syncedAtField] = new Date().toISOString();
  });
}

async function ensureRuleProject(
  client: TickTickClient,
  rule: SyncRule,
): Promise<{ id: string; name: string }> {
  const projects = await client.listProjects();

  if (!projects.length) {
    throw new Error(`No TickTick projects available. Create one in TickTick first.`);
  }

  if (rule.targetProjectId) {
    const byId = projects.find((p) => p.id === rule.targetProjectId);
    if (byId) {
      rule.targetProjectName = byId.name;
      return { id: byId.id, name: byId.name };
    }

    const byName = projects.find(
      (p) => p.name.toLowerCase() === (rule.targetProjectName || '').trim().toLowerCase(),
    );
    if (byName) {
      rule.targetProjectId = byName.id;
      rule.targetProjectName = byName.name;
      return { id: byName.id, name: byName.name };
    }

    throw new Error(
      `Rule '${rule.name}' target project is invalid (saved project not found). Re-select target project in rule settings.`,
    );
  }

  throw new Error(`Rule '${rule.name}' has no target project selected. Select one in rule settings.`);
}

export async function runSync(
  app: App,
  settings: TickTickUniversitySyncSettings,
  client: TickTickClient,
  tracking: TrackingProvider,
): Promise<{ summary: SyncSummary; failures: string[] }> {
  const summary: SyncSummary = {
    scanned: 0,
    synced: 0,
    created: 0,
    updated: 0,
    completed: 0,
    skippedCompletedNoTask: 0,
    failed: 0,
  };

  const failures: string[] = [];
  const candidates = await collectCandidates(app, settings);
  summary.scanned = candidates.length;

  for (const candidate of candidates) {
    try {
      const completed = isCompletedStatus(candidate.statusRaw, candidate.rule.completedKeywords);
      const project = await ensureRuleProject(client, candidate.rule);

      const tracked = await tracking.read(candidate);
      const existingRef = pickExistingTaskRef(candidate, tracked, settings.trackingMode);
      const effectiveTaskId = existingRef?.taskId;
      const effectiveProjectId = existingRef?.projectId || project.id;

      const selectionMode = candidate.rule.candidateSelectionMode || 'all';
      if (selectionMode === 'new_only' && effectiveTaskId) {
        continue;
      }
      if (selectionMode === 'existing_only' && !effectiveTaskId) {
        continue;
      }
      if (!shouldSyncByDueWindow(candidate.dueRaw, candidate.rule.dueWindowMode)) {
        continue;
      }

      if (completed && !effectiveTaskId && !candidate.rule.includeCompletedWithoutTaskId) {
        summary.skippedCompletedNoTask += 1;
        continue;
      }

      const payload = buildTaskPayload(
        app,
        candidate,
        settings,
        effectiveProjectId,
        candidate.rule.targetProjectName || project.name,
        effectiveTaskId,
      );

      if (settings.dryRun) {
        summary.synced += 1;
        continue;
      }

      let currentTaskId = effectiveTaskId;
      let currentProjectId = effectiveProjectId;

      if (!currentTaskId) {
        const created = await client.createTask(payload);
        currentTaskId = created.id;
        currentProjectId = created.projectId || effectiveProjectId;
        summary.created += 1;
      } else if (candidate.rule.syncMode === 'upsert') {
        const updated = await client.updateTask(currentTaskId, payload);
        currentProjectId = updated.projectId || effectiveProjectId;
        summary.updated += 1;
      }

      if (completed && currentTaskId && candidate.rule.markCompletedInTickTick) {
        await client.completeTask(currentProjectId, currentTaskId);
        summary.completed += 1;
      }

      if (currentTaskId) {
        if (settings.trackingMode === 'frontmatter') {
          await updateFrontmatterTracking(app, candidate, currentTaskId, currentProjectId);
        }

        await tracking.write(candidate, {
          taskId: currentTaskId,
          projectId: currentProjectId,
          syncedAt: new Date().toISOString(),
        });
      }
      summary.synced += 1;
    } catch (e) {
      summary.failed += 1;
      failures.push(`${candidate.file.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { summary, failures };
}
