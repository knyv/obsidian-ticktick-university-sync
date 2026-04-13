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
  TickTickTaskSummary,
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

function valueContainsAny(valueText: string, terms: string[]): boolean {
  const low = valueText.toLowerCase();
  return terms.some((t) => {
    const term = String(t || '').trim().toLowerCase();
    return term ? low.includes(term) : false;
  });
}

function normalizeStatusValue(statusRaw: unknown): string {
  if (typeof statusRaw === 'boolean') return statusRaw ? 'true' : 'false';
  const arr = toStringArray(statusRaw);
  if (arr.length) return arr.join(' ').toLowerCase();
  if (statusRaw === null || statusRaw === undefined) return '';
  return String(statusRaw).toLowerCase();
}

function resolveTaskStatusCode(candidate: SyncCandidate): 0 | 2 {
  const mode = candidate.rule.taskStatusSyncMode || 'off';
  const statusType = candidate.rule.statusPropertyType || 'text_or_list';

  if (mode !== 'obsidian_to_ticktick') {
    const done = candidate.rule.completedKeywords || ['completed', 'complete', 'done', 'finished'];
    return valueContainsAny(normalizeStatusValue(candidate.statusRaw), done) ? 2 : 0;
  }

  if (statusType === 'checkbox') {
    if (typeof candidate.statusRaw === 'boolean') return candidate.statusRaw ? 2 : 0;
    const low = normalizeStatusValue(candidate.statusRaw);
    if (['true', '1', 'yes', 'checked'].some((x) => low === x)) return 2;
    return 0;
  }

  const doneValues = (candidate.rule.statusDoneValues && candidate.rule.statusDoneValues.length)
    ? candidate.rule.statusDoneValues
    : ['completed', 'complete', 'done', 'finished'];
  const openValues = (candidate.rule.statusOpenValues && candidate.rule.statusOpenValues.length)
    ? candidate.rule.statusOpenValues
    : ['todo', 'not-started', 'not started', 'in-progress', 'in progress'];

  const low = normalizeStatusValue(candidate.statusRaw);
  if (valueContainsAny(low, doneValues)) return 2;
  if (valueContainsAny(low, openValues)) return 0;
  return 0;
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

function dueDatePrefix(dueRaw: string): string {
  return parseDueToTickTick(dueRaw)?.dueDate?.slice(0, 10) || '';
}

function sameTaskByContent(candidate: SyncCandidate, remote: TickTickTaskSummary): boolean {
  const localTitle = candidate.file.basename.trim().toLowerCase();
  const remoteTitle = String(remote.title || '').trim().toLowerCase();
  if (!localTitle || !remoteTitle || localTitle !== remoteTitle) return false;

  const localDatePrefix = dueDatePrefix(candidate.dueRaw);
  const remoteDatePrefix = String(remote.dueDate || '').slice(0, 10);
  if (localDatePrefix && remoteDatePrefix && localDatePrefix !== remoteDatePrefix) return false;

  return true;
}

function makeSyncMarker(candidate: SyncCandidate): string {
  return `[tfs:${candidate.rule.id}:${candidate.file.path}]`;
}

function findExistingTaskByMarker(candidate: SyncCandidate, tasks: TickTickTaskSummary[]): ExistingTaskRef | undefined {
  const marker = makeSyncMarker(candidate).toLowerCase();
  const found = tasks.find((t) => {
    const c = String(t.content || '').toLowerCase();
    const d = String(t.desc || '').toLowerCase();
    return c.includes(marker) || d.includes(marker);
  });

  if (found?.id) return { taskId: found.id, projectId: found.projectId };
  return undefined;
}

function findExistingTaskByHeuristic(candidate: SyncCandidate, tasks: TickTickTaskSummary[]): ExistingTaskRef | undefined {
  if (!tasks.length) return undefined;

  const title = candidate.file.basename.trim().toLowerCase();
  if (!title) return undefined;

  const datePrefix = dueDatePrefix(candidate.dueRaw);
  const titleMatches = tasks.filter((t) => String(t.title || '').trim().toLowerCase() === title);
  if (!titleMatches.length) return undefined;

  if (datePrefix) {
    const byDue = titleMatches.find((t) => String(t.dueDate || '').slice(0, 10) === datePrefix);
    if (byDue?.id) return { taskId: byDue.id, projectId: byDue.projectId };
  }

  if (titleMatches.length === 1 && titleMatches[0].id) {
    return { taskId: titleMatches[0].id, projectId: titleMatches[0].projectId };
  }

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
  const syncMarker = makeSyncMarker(candidate);
  const mergedContent = [content, sourceMarker, syncMarker].filter(Boolean).join('\n\n');

  const statusCode = resolveTaskStatusCode(candidate);

  return {
    id: existingId,
    projectId,
    title: title || candidate.file.basename,
    content: mergedContent,
    desc: desc || undefined,
    tags: ticktickTags.length ? ticktickTags : undefined,
    isAllDay: due?.isAllDay,
    startDate: due?.startDate,
    dueDate: due?.dueDate,
    timeZone: due?.timeZone,
    status: statusCode,
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
    skippedBySelectionMode: 0,
    skippedByDueWindow: 0,
    failed: 0,
  };

  const failures: string[] = [];
  const candidates = await collectCandidates(app, settings);
  summary.scanned = candidates.length;

  for (const candidate of candidates) {
    let phase = 'init';
    try {
      const statusCode = resolveTaskStatusCode(candidate);
      const completed = statusCode === 2;
      phase = 'resolve-project';
      const project = await ensureRuleProject(client, candidate.rule);

      phase = 'read-tracking';
      const tracked = await tracking.read(candidate);
      const existingRef = pickExistingTaskRef(candidate, tracked, settings.trackingMode);

      // Guard against stale cross-rule/cross-project tracking links.
      // If tracked project does not match this rule's selected target project, ignore tracked task.
      const trackedProjectMismatch = Boolean(existingRef?.projectId && existingRef.projectId !== project.id);
      const effectiveTaskId = trackedProjectMismatch ? undefined : existingRef?.taskId;
      const effectiveProjectId = trackedProjectMismatch ? project.id : (existingRef?.projectId || project.id);

      const selectionMode = candidate.rule.candidateSelectionMode || 'all';
      if (selectionMode === 'new_only' && effectiveTaskId) {
        summary.skippedBySelectionMode += 1;
        continue;
      }
      if (selectionMode === 'existing_only' && !effectiveTaskId) {
        summary.skippedBySelectionMode += 1;
        continue;
      }
      if (!shouldSyncByDueWindow(candidate.dueRaw, candidate.rule.dueWindowMode)) {
        summary.skippedByDueWindow += 1;
        continue;
      }

      let verifiedTaskId = effectiveTaskId;
      let verifiedProjectId = effectiveProjectId;
      if (effectiveTaskId && effectiveProjectId) {
        try {
          phase = 'verify-existing';
          const remote = await client.getTask(effectiveProjectId, effectiveTaskId);
          if (!sameTaskByContent(candidate, remote)) {
            verifiedTaskId = undefined;
          }
        } catch {
          verifiedTaskId = undefined;
        }
      }

      if (!verifiedTaskId) {
        try {
          phase = 'heuristic-relink';
          const tasks = await client.listProjectTasks(project.id);

          // Highest confidence: internal sync marker in content/desc.
          const byMarker = findExistingTaskByMarker(candidate, tasks);
          const found = byMarker || findExistingTaskByHeuristic(candidate, tasks);

          if (found?.taskId) {
            verifiedTaskId = found.taskId;
            verifiedProjectId = found.projectId || project.id;
          }
        } catch {
          // heuristic lookup is best-effort only
        }
      }

      if (completed && !verifiedTaskId && !candidate.rule.includeCompletedWithoutTaskId) {
        summary.skippedCompletedNoTask += 1;
        continue;
      }

      const payload = buildTaskPayload(
        app,
        candidate,
        settings,
        verifiedProjectId,
        candidate.rule.targetProjectName || project.name,
        verifiedTaskId,
      );

      if (settings.dryRun) {
        summary.synced += 1;
        continue;
      }

      // From this point onward, any thrown error means write pipeline failed for this candidate.

      let currentTaskId = verifiedTaskId;
      let currentProjectId = verifiedProjectId;

      if (!currentTaskId) {
        phase = 'create-task';
        const created = await client.createTask(payload);
        currentTaskId = created.id;
        currentProjectId = created.projectId || verifiedProjectId;
        summary.created += 1;
      } else if (candidate.rule.syncMode === 'upsert') {
        phase = 'update-task';
        const updated = await client.updateTask(currentTaskId, payload);
        currentProjectId = updated.projectId || verifiedProjectId;
        summary.updated += 1;
      }

      if (completed && currentTaskId && candidate.rule.markCompletedInTickTick) {
        phase = 'complete-task';
        await client.completeTask(currentProjectId, currentTaskId);
        summary.completed += 1;
      }

      // Keep TickTick status aligned with Obsidian status mapping.
      // If Obsidian says task is open but TickTick still shows completed, force it back to open.
      if (!completed && currentTaskId && candidate.rule.taskStatusSyncMode === 'obsidian_to_ticktick') {
        phase = 'verify-open-status';
        const remote = await client.getTask(currentProjectId, currentTaskId).catch(() => undefined);
        if ((remote?.status ?? 0) === 2) {
          phase = 'force-open-status';
          await client.updateTask(currentTaskId, { ...payload, status: 0 });

          // Last fallback for APIs/clients that ignore status=0 in update payload.
          phase = 'reopen-task';
          await client.reopenTask(currentProjectId, currentTaskId).catch(() => undefined);
        }
      }

      if (currentTaskId) {
        if (settings.trackingMode === 'frontmatter') {
          phase = 'write-frontmatter';
          await updateFrontmatterTracking(app, candidate, currentTaskId, currentProjectId);
        }

        phase = 'write-tracking';
        await tracking.write(candidate, {
          taskId: currentTaskId,
          projectId: currentProjectId,
          syncedAt: new Date().toISOString(),
        });
      }
      summary.synced += 1;
    } catch (e) {
      summary.failed += 1;
      failures.push(`${candidate.file.path} [${phase}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { summary, failures };
}
