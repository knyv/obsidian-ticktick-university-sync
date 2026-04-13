import { DEFAULT_REDIRECT_URI, DEFAULT_SCOPES } from './constants';
import { LegacySettings, SyncRule, TickTickUniversitySyncSettings } from './types';
import { makeRuleId } from './utils';

export function makeUniversityRule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: makeRuleId('university'),
    name: 'University',
    enabled: true,
    tagsAny: ['university/assignments', 'university/exams'],
    excludeTagsAny: [],
    dueFields: ['due'],
    statusField: 'status',
    classField: 'class',
    taskIdField: 'ticktick_task_id',
    projectIdField: 'ticktick_project_id',
    syncedAtField: 'ticktick_synced_at',
    targetProjectId: '',
    targetProjectName: 'University',
    includeCompletedWithoutTaskId: false,
    markCompletedInTickTick: true,
    syncMode: 'upsert',
    completedKeywords: ['completed', 'complete', 'done', 'finished'],
    titleTemplate: '{{noteTitle}}',
    contentTemplate: `Task: {{noteTitle}}
Class: {{class}}
Due: {{duePretty}}
Tags: {{tags}}
Open note: {{obsidianLink}}`,
    descTemplate: `Status: {{status}}
Project: {{projectName}}
Path: {{filePath}}
Rule: {{ruleName}}`,
    ...overrides,
  };
}

export const DEFAULT_SETTINGS: TickTickUniversitySyncSettings = {
  clientId: '',
  clientSecret: '',
  redirectUri: DEFAULT_REDIRECT_URI,
  scopes: DEFAULT_SCOPES,

  accessToken: '',
  refreshToken: '',
  tokenExpiryMs: 0,

  fallbackProjectId: '',
  fallbackProjectName: 'University',

  syncOnStartup: false,
  autoSyncMinutes: 0,
  dryRun: false,

  trackingMode: 'frontmatter',
  localTrackingFile: '.obsidian/plugins/ticktick-flow-sync/tracking.json',

  rules: [makeUniversityRule()],
};

export function migrateSettings(raw: unknown): TickTickUniversitySyncSettings {
  const data = (raw ?? {}) as LegacySettings;
  const merged = Object.assign({}, DEFAULT_SETTINGS, data) as TickTickUniversitySyncSettings;

  // If old shape had no rules, convert legacy fields into one rule
  if (!Array.isArray((data as TickTickUniversitySyncSettings).rules) || !(data as TickTickUniversitySyncSettings).rules.length) {
    const tagsAny = [data.assignmentTag, data.examTag].filter((x): x is string => Boolean(x?.trim()));
    const dueField = data.dueField?.trim() || 'due';
    const statusField = data.statusField?.trim() || 'status';
    const classField = data.classField?.trim() || 'class';
    const taskIdField = data.taskIdField?.trim() || 'ticktick_task_id';
    const projectIdField = data.projectIdField?.trim() || 'ticktick_project_id';
    const syncedAtField = data.syncedAtField?.trim() || 'ticktick_synced_at';

    merged.rules = [
      makeUniversityRule({
        tagsAny: tagsAny.length ? tagsAny : ['university/assignments', 'university/exams'],
        dueFields: [dueField],
        statusField,
        classField,
        taskIdField,
        projectIdField,
        syncedAtField,
        includeCompletedWithoutTaskId: Boolean(data.includeCompletedWithoutTaskId),
        targetProjectId: data.ticktickProjectId?.trim() || data.fallbackProjectId?.trim() || '',
        targetProjectName: data.ticktickProjectName?.trim() || data.fallbackProjectName?.trim() || 'University',
      }),
    ];
  }

  // normalize rules
  merged.rules = merged.rules.map((rule) => ({
    ...makeUniversityRule({ id: rule.id || makeRuleId(rule.name || 'rule') }),
    ...rule,
    tagsAny: Array.isArray(rule.tagsAny) ? rule.tagsAny : [],
    excludeTagsAny: Array.isArray(rule.excludeTagsAny) ? rule.excludeTagsAny : [],
    dueFields: Array.isArray(rule.dueFields) && rule.dueFields.length ? rule.dueFields : ['due'],
    completedKeywords:
      Array.isArray(rule.completedKeywords) && rule.completedKeywords.length
        ? rule.completedKeywords
        : ['completed', 'complete', 'done', 'finished'],
  }));

  if (!merged.trackingMode) merged.trackingMode = 'frontmatter';
  if (!merged.localTrackingFile?.trim()) {
    merged.localTrackingFile = '.obsidian/plugins/ticktick-flow-sync/tracking.json';
  }
  if (merged.localTrackingFile.trim() === '.obsidian/plugins/ticktick-university-sync/tracking.json') {
    merged.localTrackingFile = '.obsidian/plugins/ticktick-flow-sync/tracking.json';
  }

  // normalize missing desc template in older rules
  merged.rules = merged.rules.map((rule) => ({
    ...rule,
    contentTemplate:
      typeof (rule as { contentTemplate?: unknown }).contentTemplate === 'string' &&
      String((rule as { contentTemplate?: unknown }).contentTemplate).trim()
        ? String((rule as { contentTemplate?: unknown }).contentTemplate)
        : `Task: {{noteTitle}}
Class: {{class}}
Due: {{duePretty}}
Tags: {{tags}}
Open note: {{obsidianLink}}`,
    descTemplate:
      typeof (rule as { descTemplate?: unknown }).descTemplate === 'string' &&
      String((rule as { descTemplate?: unknown }).descTemplate).trim()
        ? String((rule as { descTemplate?: unknown }).descTemplate)
        : `Status: {{status}}
Project: {{projectName}}
Path: {{filePath}}
Rule: {{ruleName}}`,
  }));

  return merged;
}
