import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SCOPES, TICKTICK_DEVELOPER_APPS_URL } from './constants';
import { BUILTIN_PRESETS, DEFAULT_SETTINGS, migrateSettings } from './defaults';
import { exchangeCodeForToken, buildOAuthAuthorizeUrl, refreshToken } from './oauth';
import { PluginApi } from './pluginApi';
import { runSync } from './sync';
import { TickTickClient } from './ticktickClient';
import { TickTickUniversitySyncSettings } from './types';
import { getTrackingForCandidate, setTrackingForCandidate } from './tracking';
import { AuthCodeModal } from './ui/authCodeModal';
import { TickTickSyncSettingTab } from './ui/settingsTab';

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
      id: 'ticktick-flow-open-auth-url',
      name: 'Beginner path: open TickTick OAuth URL (step 4)',
      callback: async () => {
        this.openOAuthUrl();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-open-developer-apps',
      name: 'Beginner path: open TickTick Developer Apps (step 1)',
      callback: async () => {
        this.openTickTickDeveloperPage();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-exchange-auth-code',
      name: 'Beginner path: exchange auth code/URL (manual alt)',
      callback: async () => {
        new AuthCodeModal(this.app, async (input) => {
          await this.exchangeAuthCode(input);
        }).open();
      },
    });

    this.addCommand({
      id: 'ticktick-flow-exchange-auth-from-clipboard',
      name: 'Beginner path: exchange auth from clipboard (step 6)',
      callback: async () => {
        await this.exchangeAuthCodeFromClipboard();
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
      completedKeywords: [...rule.completedKeywords],
      titleTemplate: rule.titleTemplate,
      contentTemplate: rule.contentTemplate,
      descTemplate: rule.descTemplate,
      ticktickTagsField: rule.ticktickTagsField,
      tagSourceMode: rule.tagSourceMode,
      fixedTickTickTags: [...(rule.fixedTickTickTags || [])],
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
        read: async (candidate) => getTrackingForCandidate(this.app, this.settings, candidate),
        write: async (candidate, entry) => {
          if (this.settings.trackingMode === 'local_json') {
            await setTrackingForCandidate(this.app, this.settings, candidate, entry);
          }
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
      }
    } catch (e) {
      console.error('[TickTick Flow Sync] Fatal sync error:', e);
      new Notice(`TickTick sync failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
      throw e;
    }
  }
}
