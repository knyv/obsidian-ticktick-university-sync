import { TFile } from 'obsidian';

export type SyncMode = 'upsert' | 'create_only';
export type TrackingMode = 'frontmatter' | 'local_json';
export type TagSourceMode = 'all_note_tags' | 'include_tags';

export interface CustomRulePreset {
  id: string;
  name: string;
  description: string;
  tagsAny: string[];
  excludeTagsAny: string[];
  dueFields: string[];
  targetProjectName: string;
  syncMode: SyncMode;
}

export interface SyncRule {
  id: string;
  name: string;
  enabled: boolean;

  // match notes where frontmatter tags includes any of these
  tagsAny: string[];
  // skip note if any of these tags are present
  excludeTagsAny: string[];

  // frontmatter field mapping
  dueFields: string[];
  statusField: string;
  classField: string;
  taskIdField: string;
  projectIdField: string;
  syncedAtField: string;

  // project targeting
  targetProjectId: string;
  targetProjectName: string;

  // behavior
  includeCompletedWithoutTaskId: boolean;
  markCompletedInTickTick: boolean;
  syncMode: SyncMode;
  completedKeywords: string[];

  // rendering templates
  // Supported tokens:
  // {{noteTitle}} {{filePath}} {{class}} {{obsidianLink}} {{ruleName}} {{dueRaw}}
  // {{duePretty}} {{status}} {{tags}} {{projectName}}
  titleTemplate: string;
  contentTemplate: string;
  descTemplate: string;

  // optional metadata mappings
  ticktickTagsField?: string;
  tagSourceMode?: TagSourceMode;
}


export interface TickTickUniversitySyncSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;

  accessToken: string;
  refreshToken: string;
  tokenExpiryMs: number;

  fallbackProjectId: string;
  fallbackProjectName: string;

  syncOnStartup: boolean;
  autoSyncMinutes: number;
  dryRun: boolean;

  trackingMode: TrackingMode;
  localTrackingFile: string;
  allowAllPropertyTokens: boolean;
  customPresets: CustomRulePreset[];

  rules: SyncRule[];
}

export type TickTickProject = {
  id: string;
  name: string;
  closed?: number;
};

export type TickTickTaskPayload = {
  id?: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  tags?: string[];
  isAllDay?: boolean;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  status?: number;
};

export type SyncCandidate = {
  file: TFile;
  frontmatter: Record<string, unknown>;
  rule: SyncRule;
  dueRaw: string;
  tags: string[];
  classNames: string[];
  statusRaw: unknown;
  taskId?: string;
  projectId?: string;
};

export type SyncSummary = {
  scanned: number;
  synced: number;
  created: number;
  updated: number;
  completed: number;
  skippedCompletedNoTask: number;
  failed: number;
};

export type TrackingEntry = {
  taskId: string;
  projectId: string;
  syncedAt: string;
};

export type TrackingMap = Record<string, TrackingEntry>;

// minimal shape for migrating legacy settings from v0.1.0
export type LegacySettings = Partial<TickTickUniversitySyncSettings> & {
  ticktickProjectId?: string;
  ticktickProjectName?: string;
  assignmentTag?: string;
  examTag?: string;
  dueField?: string;
  statusField?: string;
  classField?: string;
  taskIdField?: string;
  projectIdField?: string;
  syncedAtField?: string;
  includeCompletedWithoutTaskId?: boolean;
};
