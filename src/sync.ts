import { App, TFile } from 'obsidian';
import { parseDueToTickTick } from './datetime';
import { TickTickClient } from './ticktickClient';
import { SyncCandidate, SyncRule, SyncSummary, TickTickTaskPayload, TickTickUniversitySyncSettings } from './types';
import { firstNonEmptyField, normalizeTag, renderTemplate, toStringArray } from './utils';

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
      if (!dueRaw) continue;

      const classNames = toStringArray(fm[rule.classField]);
      const statusRaw = fm[rule.statusField];
      const taskId = String(fm[rule.taskIdField] ?? '').trim() || undefined;
      const projectId = String(fm[rule.projectIdField] ?? '').trim() || undefined;

      candidates.push({
        file,
        rule,
        dueRaw,
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

function buildTaskPayload(app: App, candidate: SyncCandidate, projectId: string, existingId?: string): TickTickTaskPayload {
  const due = parseDueToTickTick(candidate.dueRaw);
  const classText = candidate.classNames.length ? candidate.classNames.join(', ') : '(not set)';
  const noteLink = getObsidianDeepLink(app, candidate.file);

  const title = renderTemplate(candidate.rule.titleTemplate, {
    noteTitle: candidate.file.basename,
    filePath: candidate.file.path,
    class: classText,
    obsidianLink: noteLink,
    ruleName: candidate.rule.name,
    dueRaw: candidate.dueRaw,
  }).trim();

  const content = renderTemplate(candidate.rule.contentTemplate, {
    noteTitle: candidate.file.basename,
    filePath: candidate.file.path,
    class: classText,
    obsidianLink: noteLink,
    ruleName: candidate.rule.name,
    dueRaw: candidate.dueRaw,
  })
    .replace(/\\n/g, '\n')
    .trim();

  return {
    id: existingId,
    projectId,
    title: title || candidate.file.basename,
    content,
    isAllDay: due.isAllDay,
    startDate: due.startDate,
    dueDate: due.dueDate,
    timeZone: due.timeZone,
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

async function ensureRuleProjectId(
  client: TickTickClient,
  settings: TickTickUniversitySyncSettings,
  rule: SyncRule,
): Promise<string> {
  if (rule.targetProjectId) return rule.targetProjectId;

  const projects = await client.listProjects();
  const wanted = rule.targetProjectName.trim().toLowerCase() || settings.fallbackProjectName.trim().toLowerCase();

  let selected = projects.find((p) => p.name.toLowerCase() === wanted);
  if (!selected) {
    selected =
      projects.find((p) => ['university', 'school', 'study'].includes(p.name.toLowerCase())) ??
      projects.find((p) => p.name.toLowerCase() === 'inbox') ??
      projects[0];
  }

  if (!selected) {
    throw new Error(`No TickTick project found for rule '${rule.name}'.`);
  }

  rule.targetProjectId = selected.id;
  rule.targetProjectName = selected.name;
  return selected.id;
}

export async function runSync(
  app: App,
  settings: TickTickUniversitySyncSettings,
  client: TickTickClient,
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
      const projectId = candidate.projectId || (await ensureRuleProjectId(client, settings, candidate.rule));

      if (completed && !candidate.taskId && !candidate.rule.includeCompletedWithoutTaskId) {
        summary.skippedCompletedNoTask += 1;
        continue;
      }

      if (!candidate.taskId && candidate.rule.syncMode === 'create_only') {
        // allowed: create new
      }

      const payload = buildTaskPayload(app, candidate, projectId, candidate.taskId);

      if (settings.dryRun) {
        summary.synced += 1;
        continue;
      }

      let currentTaskId = candidate.taskId;
      let currentProjectId = projectId;

      if (!currentTaskId) {
        const created = await client.createTask(payload);
        currentTaskId = created.id;
        currentProjectId = created.projectId || projectId;
        summary.created += 1;
      } else if (candidate.rule.syncMode === 'upsert') {
        const updated = await client.updateTask(currentTaskId, payload);
        currentProjectId = updated.projectId || projectId;
        summary.updated += 1;
      }

      if (completed && currentTaskId && candidate.rule.markCompletedInTickTick) {
        await client.completeTask(currentProjectId, currentTaskId);
        summary.completed += 1;
      }

      if (currentTaskId) {
        await updateFrontmatterTracking(app, candidate, currentTaskId, currentProjectId);
      }
      summary.synced += 1;
    } catch (e) {
      summary.failed += 1;
      failures.push(`${candidate.file.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { summary, failures };
}
