import { DEFAULT_REDIRECT_URI, DEFAULT_SCOPES } from './constants';
import { CustomRulePreset, LegacySettings, SyncRule, TickTickUniversitySyncSettings } from './types';
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
    includeCompletedWithoutTaskId: true,
    markCompletedInTickTick: true,
    syncMode: 'upsert',
    taskStatusSyncMode: 'off',
    statusPropertyType: 'text_or_list',
    statusDoneValues: ['completed', 'complete', 'done', 'finished'],
    statusOpenValues: ['todo', 'not-started', 'not started', 'in-progress', 'in progress'],
    requireDueDate: true,
    candidateSelectionMode: 'all',
    dueWindowMode: 'all',
    completedKeywords: ['completed', 'complete', 'done', 'finished'],
    titleTemplate: '{{noteTitle}}',
    contentTemplate: ``,
    descTemplate: ``,
    ticktickTagsField: 'ticktick_tags',
    tagSourceMode: 'all_note_tags',
    fixedTickTickTags: [],
    ticktickTagAssignmentMode: 'merge',
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
  startupSyncDelayMs: 6000,
  autoSyncMinutes: 0,
  dryRun: false,

  trackingMode: 'frontmatter',
  localTrackingFile: '.obsidian/plugins/ticktick-flow-sync/tracking.json',
  allowAllPropertyTokens: true,
  customPresets: [],

  simpleMode: true,
  preloadProjectsOnStartup: true,
  preloadProjectsDelayMs: 3500,

  addSourceMarker: false,
  sourceMarkerText: 'Created by TickTick Flow Sync',

  rules: [makeUniversityRule()],
};

export const BUILTIN_PRESETS: CustomRulePreset[] = [
  {
    id: 'deadlines',
    name: 'Deadlines',
    description: 'Generic due-date items. Good starter for any deadline-oriented notes.',
    tagsAny: ['deadlines'],
    excludeTagsAny: [],
    dueFields: ['due', 'deadline', 'date'],
    targetProjectName: 'Inbox',
    syncMode: 'upsert',
  },
  {
    id: 'personal-tasks',
    name: 'Personal tasks',
    description: 'Personal action items (home/life/admin).',
    tagsAny: ['tasks/personal'],
    excludeTagsAny: [],
    dueFields: ['due', 'deadline'],
    targetProjectName: 'Personal',
    syncMode: 'upsert',
  },
  {
    id: 'work-items',
    name: 'Work items',
    description: 'Work/project tasks for job or side projects.',
    tagsAny: ['tasks/work'],
    excludeTagsAny: [],
    dueFields: ['due', 'deadline'],
    targetProjectName: 'Work',
    syncMode: 'upsert',
  },
  {
    id: 'general-tasks',
    name: 'General tasks',
    description: 'Task sync mode for notes without strict due-date requirement.',
    tagsAny: ['tasks'],
    excludeTagsAny: [],
    dueFields: ['due', 'deadline'],
    targetProjectName: 'Inbox',
    syncMode: 'upsert',
    requireDueDate: false,
  },
];

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
    requireDueDate: typeof rule.requireDueDate === 'boolean' ? rule.requireDueDate : true,
    candidateSelectionMode:
      rule.candidateSelectionMode === 'new_only' || rule.candidateSelectionMode === 'existing_only'
        ? rule.candidateSelectionMode
        : 'all',
    dueWindowMode:
      rule.dueWindowMode === 'overdue_only' || rule.dueWindowMode === 'not_overdue_only'
        ? rule.dueWindowMode
        : 'all',
    taskStatusSyncMode:
      rule.taskStatusSyncMode === 'obsidian_to_ticktick' ||
      rule.taskStatusSyncMode === 'ticktick_to_obsidian' ||
      rule.taskStatusSyncMode === 'newest_wins'
        ? rule.taskStatusSyncMode
        : 'off',
    statusPropertyType: rule.statusPropertyType === 'checkbox' ? 'checkbox' : 'text_or_list',
    statusDoneValues: Array.isArray(rule.statusDoneValues)
      ? rule.statusDoneValues.map((x) => String(x).trim()).filter(Boolean)
      : ['completed', 'complete', 'done', 'finished'],
    statusOpenValues: Array.isArray(rule.statusOpenValues)
      ? rule.statusOpenValues.map((x) => String(x).trim()).filter(Boolean)
      : ['todo', 'not-started', 'not started', 'in-progress', 'in progress'],
    ticktickTagsField: typeof rule.ticktickTagsField === 'string' && rule.ticktickTagsField.trim()
      ? rule.ticktickTagsField
      : 'ticktick_tags',
    tagSourceMode: rule.tagSourceMode === 'all_note_tags' ? 'all_note_tags' : 'none',
    fixedTickTickTags: Array.isArray(rule.fixedTickTickTags)
      ? rule.fixedTickTickTags.map((x) => String(x).trim()).filter(Boolean)
      : [],
    ticktickTagAssignmentMode: rule.ticktickTagAssignmentMode === 'rule_only' ? 'rule_only' : 'merge',
  }));

  if (!merged.trackingMode) merged.trackingMode = 'frontmatter';
  if (!merged.localTrackingFile?.trim()) {
    merged.localTrackingFile = '.obsidian/plugins/ticktick-flow-sync/tracking.json';
  }
  if (typeof merged.allowAllPropertyTokens !== 'boolean') {
    merged.allowAllPropertyTokens = true;
  }
  if (!Array.isArray(merged.customPresets)) {
    merged.customPresets = [];
  }
  if (typeof merged.simpleMode !== 'boolean') merged.simpleMode = true;
  if (typeof merged.preloadProjectsOnStartup !== 'boolean') merged.preloadProjectsOnStartup = true;
  if (!Number.isFinite(merged.preloadProjectsDelayMs) || merged.preloadProjectsDelayMs < 0) merged.preloadProjectsDelayMs = 3500;
  if (!Number.isFinite((merged as TickTickUniversitySyncSettings).startupSyncDelayMs) || (merged as TickTickUniversitySyncSettings).startupSyncDelayMs < 0) {
    (merged as TickTickUniversitySyncSettings).startupSyncDelayMs = 6000;
  }
  if (typeof merged.addSourceMarker !== 'boolean') merged.addSourceMarker = true;
  if (!merged.sourceMarkerText?.trim()) merged.sourceMarkerText = 'Created by TickTick Flow Sync';
  if (merged.localTrackingFile.trim() === '.obsidian/plugins/ticktick-university-sync/tracking.json') {
    merged.localTrackingFile = '.obsidian/plugins/ticktick-flow-sync/tracking.json';
  }

  // normalize missing desc template in older rules
  merged.rules = merged.rules.map((rule) => ({
    ...rule,
    contentTemplate:
      typeof (rule as { contentTemplate?: unknown }).contentTemplate === 'string'
        ? String((rule as { contentTemplate?: unknown }).contentTemplate)
        : ``,
    descTemplate:
      typeof (rule as { descTemplate?: unknown }).descTemplate === 'string'
        ? String((rule as { descTemplate?: unknown }).descTemplate)
        : ``,
  }));

  return merged;
}
