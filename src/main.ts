import { FuzzySuggestModal, Notice, Plugin } from 'obsidian';
import { DEFAULT_SCOPES, TICKTICK_DEVELOPER_APPS_URL } from './constants';
import { BUILTIN_PRESETS, DEFAULT_SETTINGS, migrateSettings } from './defaults';
import { exchangeCodeForToken, buildOAuthAuthorizeUrl, refreshToken } from './oauth';
import { PluginApi } from './pluginApi';
import { runSync } from './sync';
import { TickTickClient } from './ticktickClient';
import { TickTickUniversitySyncSettings } from './types';
import { getTrackingForCandidate, setTrackingForCandidate } from './tracking';
import { TickTickSyncSettingTab } from './ui/settingsTab';

class TaskPickerModal extends FuzzySuggestModal<{ id: string; title?: string; dueDate?: string }> {
  private items: { id: string; title?: string; dueDate?: string }[];
  private onChoose: (item: { id: string; title?: string; dueDate?: string }) => Promise<void>;

  constructor(
    app: Plugin['app'],
    items: { id: string; title?: string; dueDate?: string }[],
    onChoose: (item: { id: string; title?: string; dueDate?: string }) => Promise<void>,
  ) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.setPlaceholder('Pick TickTick task to link with current note');
  }

  getItems() {
    return this.items;
  }

  getItemText(item: { id: string; title?: string; dueDate?: string }) {
    const due = item.dueDate ? ` | due ${String(item.dueDate).slice(0, 10)}` : '';
    return `${item.title || '(untitled)'}${due}`;
  }

  async onChooseItem(item: { id: string; title?: string; dueDate?: string }): Promise<void> {
    await this.onChoose(item);
  }
}

export default class TickTickSyncPlugin extends Plugin implements PluginApi {
  settings: TickTickUniversitySyncSettings = DEFAULT_SETTINGS;
  private syncTimer: number | null = null;
  private client!: TickTickClient;
  private cachedProjects: { id: string; name: string; closed?: number }[] = [];
  private startupPreloadTimer: number | null = null;
  private startupSyncTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.client = new TickTickClient({
      getAccessToken: async () => {
        await this.ensureAccessToken();
        return this.settings.accessToken;
      },
      refreshIfNeeded: async () => {
        if (this.settings.refreshToken) {
          await this.refreshAccessToken();
        }
      },
    });

    this.addCommand({
      id: 'ticktick-flow-sync-now',
      name: 'Sync notes to TickTick now',
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-refresh-token',
      name: 'Connection: refresh TickTick token',
      callback: async () => {
        await this.refreshAccessToken();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-test-connection',
      name: 'Connection check: test TickTick API',
      callback: async () => {
        await this.testConnection();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-discover-projects',
      name: 'Projects: validate and refresh selected target projects',
      callback: async () => {
        await this.discoverAndSelectProject();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-load-projects',
      name: 'Projects: load TickTick project list',
      callback: async () => {
        await this.preloadProjects();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-suggest-tags',
      name: 'Tags: fetch known TickTick tags (preview)',
      callback: async () => {
        const tags = await this.listKnownTags();
        if (!tags.length) {
          new Notice('No TickTick tags found yet.');
          return;
        }
        new Notice(`Known TickTick tags: ${tags.slice(0, 10).join(', ')}${tags.length > 10 ? '…' : ''}`);
      },
    });

    this.addCommand({
      id: 'ticktick-flow-link-existing-task',
      name: 'Tracking: link note to existing TickTick task',
      callback: async () => {
        await this.linkCurrentNoteToExistingTask();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-clean-stale-tracking',
      name: 'Tracking: remove stale task IDs (missing in TickTick)',
      callback: async () => {
        await this.cleanStaleTracking();
      },
    });

    this.addSettingTab(new TickTickSyncSettingTab(this.app, this));

    this.setupAutoSync();

    if (this.settings.preloadProjectsOnStartup) {
      const delay = Math.max(0, this.settings.preloadProjectsDelayMs || 0);
      this.startupPreloadTimer = window.setTimeout(async () => {
        try {
          if (!this.settings.accessToken) return;
          const run = async () => {
            try {
              await this.preloadProjects();
            } catch {
              // silent by design for startup performance
            }
          };
          const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
          if (typeof ric === 'function') ric(() => { void run(); }, { timeout: 2500 });
          else await run();
        } catch {
          // silent by design for startup performance
        }
      }, delay);
    }

    if (this.settings.syncOnStartup) {
      const delay = Math.max(0, this.settings.startupSyncDelayMs || 0);
      this.startupSyncTimer = window.setTimeout(() => {
        if (!this.settings.accessToken) return;
        this.syncNow().catch((e) => {
          console.error('[TickTick Flow Sync] Startup sync failed:', e);
        });
      }, delay);
    }
  }

  onunload() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.startupPreloadTimer !== null) {
      window.clearTimeout(this.startupPreloadTimer);
      this.startupPreloadTimer = null;
    }
    if (this.startupSyncTimer !== null) {
      window.clearTimeout(this.startupSyncTimer);
      this.startupSyncTimer = null;
    }
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = migrateSettings(raw);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.setupAutoSync();
  }

  private setupAutoSync() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    const mins = this.settings.autoSyncMinutes;
    if (mins > 0) {
      this.syncTimer = window.setInterval(async () => {
        try {
          await this.syncNow();
        } catch (e) {
          console.error('[TickTick Flow Sync] Auto-sync error:', e);
        }
      }, mins * 60 * 1000);
    }
  }

  openOAuthUrl() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice('Set TickTick Client ID + Client Secret first.');
      return;
    }
    const url = buildOAuthAuthorizeUrl(this.settings.clientId, this.settings.scopes || DEFAULT_SCOPES, this.settings.redirectUri);
    window.open(url, '_blank');
    new Notice('Opened TickTick OAuth page. Authorize, then paste redirect URL/code back.');
  }

  openTickTickDeveloperPage() {
    window.open(TICKTICK_DEVELOPER_APPS_URL, '_blank');
    new Notice('Opened TickTick developer apps page.');
  }

  async exchangeAuthCode(input: string) {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice('Set TickTick Client ID + Client Secret first.');
      return;
    }

    const token = await exchangeCodeForToken({
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      codeInput: input,
      scopes: this.settings.scopes || DEFAULT_SCOPES,
      redirectUri: this.settings.redirectUri,
    });

    this.settings.accessToken = token.accessToken;
    this.settings.refreshToken = token.refreshToken || this.settings.refreshToken;
    this.settings.tokenExpiryMs = token.tokenExpiryMs;
    await this.saveSettings();

    new Notice('TickTick connected successfully.');
  }

  async exchangeAuthCodeFromClipboard() {
    if (!navigator?.clipboard) {
      throw new Error('Clipboard access unavailable. Use manual paste instead.');
    }

    const text = await navigator.clipboard.readText();
    if (!text?.trim()) {
      throw new Error('Clipboard is empty. Copy redirect URL/code first.');
    }

    await this.exchangeAuthCode(text);
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) {
      throw new Error('No refresh token available. Reconnect TickTick.');
    }

    const token = await refreshToken({
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      refreshToken: this.settings.refreshToken,
      scopes: this.settings.scopes || DEFAULT_SCOPES,
    });

    this.settings.accessToken = token.accessToken;
    this.settings.refreshToken = token.refreshToken;
    this.settings.tokenExpiryMs = token.tokenExpiryMs;
    await this.saveSettings();
  }

  private async ensureAccessToken() {
    if (!this.settings.accessToken) {
      throw new Error('No access token set. Run OAuth connection first.');
    }

    if (this.settings.tokenExpiryMs && Date.now() > this.settings.tokenExpiryMs) {
      await this.refreshAccessToken();
    }
  }

  async listProjects() {
    if (this.cachedProjects.length) {
      return this.cachedProjects;
    }
    const projects = await this.client.listProjects();
    this.cachedProjects = projects;
    return projects;
  }

  async preloadProjects() {
    const projects = await this.client.listProjects();
    this.cachedProjects = projects;
    if (!this.settings.simpleMode) {
      new Notice(`Loaded ${projects.length} TickTick projects.`);
    }
  }

  async listKnownTags() {
    return this.client.listKnownTags();
  }

  async discoverAndSelectProject(ruleId?: string) {
    const projects = await this.listProjects();
    if (!projects.length) {
      new Notice('No TickTick projects found.');
      return;
    }

    if (ruleId) {
      const rule = this.settings.rules.find((r) => r.id === ruleId);
      if (!rule) throw new Error(`Rule not found: ${ruleId}`);

      if (rule.targetProjectId) {
        const match = projects.find((p) => p.id === rule.targetProjectId);
        if (match) {
          rule.targetProjectName = match.name;
          await this.saveSettings();
          new Notice(`Rule '${rule.name}' project is valid: ${match.name}`);
          return;
        }
      }

      const byName = projects.find((p) => p.name.toLowerCase() === (rule.targetProjectName || '').trim().toLowerCase());
      if (byName) {
        rule.targetProjectId = byName.id;
        rule.targetProjectName = byName.name;
        await this.saveSettings();
        new Notice(`Rule '${rule.name}' project refreshed by name: ${byName.name}`);
        return;
      }

      new Notice(`Rule '${rule.name}' has no valid target project. Select one in rule settings.`);
      return;
    }

    let refreshed = 0;
    let invalid = 0;

    for (const rule of this.settings.rules) {
      if (!rule.targetProjectId) {
        invalid += 1;
        continue;
      }

      const match = projects.find((p) => p.id === rule.targetProjectId);
      if (match) {
        rule.targetProjectName = match.name;
        refreshed += 1;
      } else {
        invalid += 1;
      }
    }

    await this.saveSettings();
    new Notice(`Project validation complete: ${refreshed} valid, ${invalid} need re-selection.`);
  }

  async testConnection() {
    const projects = await this.client.listProjects();
    this.cachedProjects = projects;
    new Notice(`TickTick connected. Projects: ${projects.length}`);
  }

  async cleanStaleTracking() {
    const path = this.settings.localTrackingFile || '.obsidian/plugins/ticktick-flow-sync/tracking.json';
    const exists = await this.app.vault.adapter.exists(path);
    if (!exists) {
      new Notice('No tracking file found.');
      return;
    }

    const raw = await this.app.vault.adapter.read(path).catch(() => '');
    if (!raw.trim()) {
      new Notice('Tracking file is empty.');
      return;
    }

    let map: Record<string, { taskId?: string; projectId?: string; syncedAt?: string }> = {};
    try {
      map = JSON.parse(raw);
    } catch {
      new Notice('Tracking file is not valid JSON.');
      return;
    }

    let removed = 0;
    for (const [key, entry] of Object.entries(map)) {
      const pid = String(entry?.projectId || '');
      const tid = String(entry?.taskId || '');
      if (!pid || !tid) continue;

      try {
        await this.client.getTask(pid, tid);
      } catch {
        delete map[key];
        removed += 1;
      }
    }

    await this.app.vault.adapter.write(path, JSON.stringify(map, null, 2));
    new Notice(`Tracking cleanup done. Removed ${removed} stale entries.`);
  }

  async linkCurrentNoteToExistingTask() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Open a note first.');
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
    const tags = (Array.isArray(fm.tags) ? fm.tags.map((x) => String(x)) : typeof fm.tags === 'string' ? String(fm.tags).split(',') : [])
      .map((x) => x.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    const rule = this.settings.rules.find((r) =>
      r.enabled && r.tagsAny.some((t) => tags.includes(String(t).trim().replace(/^#/, '').toLowerCase())),
    ) || this.settings.rules.find((r) => r.enabled);

    if (!rule) {
      new Notice('No enabled rule found for this note.');
      return;
    }

    const projects = await this.listProjects();
    const pid = rule.targetProjectId || projects.find((p) => p.name.toLowerCase() === rule.targetProjectName.toLowerCase())?.id;
    if (!pid) {
      new Notice('Rule has no valid target project. Select one first.');
      return;
    }

    const tasks = await this.client.listProjectTasks(pid);
    const modal = new TaskPickerModal(this.app, tasks, async (picked) => {
      if (!picked?.id) return;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        (frontmatter as Record<string, unknown>)[rule.taskIdField] = picked.id;
        (frontmatter as Record<string, unknown>)[rule.projectIdField] = pid;
        (frontmatter as Record<string, unknown>)[rule.syncedAtField] = new Date().toISOString();
      });

      await setTrackingForCandidate(
        this.app,
        this.settings,
        {
          file,
          frontmatter: fm,
          rule,
          dueRaw: '',
          tags,
          classNames: [],
          statusRaw: fm[rule.statusField],
          taskId: picked.id,
          projectId: pid,
        },
        { taskId: picked.id, projectId: pid, syncedAt: new Date().toISOString() },
        { forceLocal: true },
      );
      new Notice(`Linked to TickTick task: ${picked.title || picked.id}`);
    });
    modal.open();
  }

  getBuiltInPresets() {
    return BUILTIN_PRESETS;
  }

  async createCustomPresetFromRule(ruleId: string, name: string, description: string) {
    const rule = this.settings.rules.find((r) => r.id === ruleId);
    if (!rule) throw new Error(`Rule not found: ${ruleId}`);

    this.settings.customPresets.push({
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      name: name.trim() || `Preset from ${rule.name}`,
      description: description.trim() || `Custom preset generated from rule '${rule.name}'.`,
      tagsAny: [...rule.tagsAny],
      excludeTagsAny: [...rule.excludeTagsAny],
      dueFields: [...rule.dueFields],
      targetProjectName: rule.targetProjectName,
      syncMode: rule.syncMode,
      requireDueDate: rule.requireDueDate,
      markCompletedInTickTick: rule.markCompletedInTickTick,
      includeCompletedWithoutTaskId: rule.includeCompletedWithoutTaskId,
      candidateSelectionMode: rule.candidateSelectionMode,
      dueWindowMode: rule.dueWindowMode,
      taskStatusSyncMode: rule.taskStatusSyncMode,
      statusPropertyType: rule.statusPropertyType,
      statusDoneValues: [...(rule.statusDoneValues || [])],
      statusOpenValues: [...(rule.statusOpenValues || [])],
      completedKeywords: [...rule.completedKeywords],
      titleTemplate: rule.titleTemplate,
      contentTemplate: rule.contentTemplate,
      descTemplate: rule.descTemplate,
      ticktickTagsField: rule.ticktickTagsField,
      tagSourceMode: rule.tagSourceMode,
      fixedTickTickTags: [...(rule.fixedTickTickTags || [])],
      ticktickTagAssignmentMode: rule.ticktickTagAssignmentMode,
      statusField: rule.statusField,
      classField: rule.classField,
    });
    await this.saveSettings();
    new Notice('Custom preset saved.');
  }

  async removeCustomPreset(presetId: string) {
    const before = this.settings.customPresets.length;
    this.settings.customPresets = this.settings.customPresets.filter((p) => p.id !== presetId);
    if (this.settings.customPresets.length !== before) {
      await this.saveSettings();
      new Notice('Custom preset removed.');
    }
  }

  async resetSettingsToDefault() {
    this.settings = migrateSettings(DEFAULT_SETTINGS);
    this.cachedProjects = [];
    await this.saveSettings();
    new Notice('TickTick Flow Sync settings reset to defaults.');
  }

  async syncNow() {
    const start = Date.now();

    try {
      const { summary, failures } = await runSync(this.app, this.settings, this.client, {
        read: async (candidate) => {
          // In frontmatter mode, still read local-json as fallback so existing tracked tasks update instead of duplicating.
          const forceLocalFallback = this.settings.trackingMode === 'frontmatter';
          return getTrackingForCandidate(this.app, this.settings, candidate, { forceLocal: forceLocalFallback });
        },
        write: async (candidate, entry) => {
          // Always keep local-json mirror for stable migration/fallback across tracking modes.
          await setTrackingForCandidate(this.app, this.settings, candidate, entry, { forceLocal: true });
        },
      });

      await this.saveSettings(); // persist discovered project IDs

      const tookMs = Date.now() - start;
      new Notice(
        `TickTick sync done: scanned ${summary.scanned}, synced ${summary.synced}, created ${summary.created}, updated ${summary.updated}, completed ${summary.completed}, failed ${summary.failed} (${Math.round(tookMs / 1000)}s)`,
        8000,
      );

      if (failures.length) {
        console.error('[TickTick Flow Sync] Failures:', failures);
        const preview = failures.slice(0, 3).join(' | ');
        new Notice(`Sync failures (${failures.length}): ${preview}${failures.length > 3 ? ' ...check console for full list' : ''}`, 10000);
      }
    } catch (e) {
      console.error('[TickTick Flow Sync] Fatal sync error:', e);
      new Notice(`TickTick sync failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
      throw e;
    }
  }
}
