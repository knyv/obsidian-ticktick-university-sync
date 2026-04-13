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
      name: 'Projects: auto-select target project for first rule',
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

    if (this.settings.syncOnStartup) {
      this.syncNow().catch((e) => {
        console.error('[TickTick Flow Sync] Startup sync failed:', e);
      });
    }
  }

  onunload() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
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
    new Notice(`Loaded ${projects.length} TickTick projects.`);
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

      const wanted = rule.targetProjectName.trim().toLowerCase();
      let selected = projects.find((p) => p.name.toLowerCase() === wanted);
      if (!selected) {
        selected = projects.find((p) => p.name.toLowerCase() === 'inbox') ?? projects[0];
      }

      rule.targetProjectId = selected.id;
      rule.targetProjectName = selected.name;
      await this.saveSettings();
      new Notice(`Selected project for rule '${rule.name}': ${selected.name}`);
      return;
    }

    const firstRule = this.settings.rules[0];
    if (!firstRule) {
      new Notice('No rules configured. Add one first in settings.');
      return;
    }

    const wanted = firstRule.targetProjectName.trim().toLowerCase();
    let selected = projects.find((p) => p.name.toLowerCase() === wanted);
    if (!selected) {
      selected = projects.find((p) => ['university', 'school', 'study'].includes(p.name.toLowerCase())) ?? projects[0];
    }

    firstRule.targetProjectId = selected.id;
    firstRule.targetProjectName = selected.name;
    this.settings.fallbackProjectId = selected.id;
    this.settings.fallbackProjectName = selected.name;
    await this.saveSettings();

    new Notice(`Selected TickTick project: ${selected.name}`);
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
    });
    await this.saveSettings();
    new Notice('Custom preset saved.');
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
