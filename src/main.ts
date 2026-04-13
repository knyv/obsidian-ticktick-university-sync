import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from 'obsidian';

type TickTickTaskPayload = {
  id?: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  isAllDay?: boolean;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  status?: number;
};

type TickTickProject = {
  id: string;
  name: string;
  closed?: number;
};

type SyncCandidate = {
  file: TFile;
  dueRaw: string;
  tags: string[];
  classNames: string[];
  statusRaw: unknown;
  taskId?: string;
  projectId?: string;
};

interface TickTickUniversitySyncSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;

  accessToken: string;
  refreshToken: string;
  tokenExpiryMs: number;

  ticktickProjectId: string;
  ticktickProjectName: string;

  assignmentTag: string;
  examTag: string;

  dueField: string;
  statusField: string;
  classField: string;
  taskIdField: string;
  projectIdField: string;
  syncedAtField: string;

  includeCompletedWithoutTaskId: boolean;
  syncOnStartup: boolean;
  autoSyncMinutes: number;
  dryRun: boolean;
}

const DEFAULT_SETTINGS: TickTickUniversitySyncSettings = {
  clientId: '',
  clientSecret: '',
  redirectUri: 'https://localhost/',
  scopes: 'tasks:read tasks:write',

  accessToken: '',
  refreshToken: '',
  tokenExpiryMs: 0,

  ticktickProjectId: '',
  ticktickProjectName: 'University',

  assignmentTag: 'university/assignments',
  examTag: 'university/exams',

  dueField: 'due',
  statusField: 'status',
  classField: 'class',
  taskIdField: 'ticktick_task_id',
  projectIdField: 'ticktick_project_id',
  syncedAtField: 'ticktick_synced_at',

  includeCompletedWithoutTaskId: false,
  syncOnStartup: false,
  autoSyncMinutes: 0,
  dryRun: false,
};

const TICKTICK_API_BASE = 'https://api.ticktick.com';
const TICKTICK_OAUTH_AUTHORIZE = 'https://ticktick.com/oauth/authorize';
const TICKTICK_OAUTH_TOKEN = 'https://ticktick.com/oauth/token';

export default class TickTickUniversitySyncPlugin extends Plugin {
  settings: TickTickUniversitySyncSettings = DEFAULT_SETTINGS;
  private syncTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'ticktick-university-sync-now',
      name: 'Sync university deadlines to TickTick now',
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: 'ticktick-university-open-auth-url',
      name: 'Open TickTick OAuth authorization URL',
      callback: async () => {
        this.openOAuthUrl();
      },
    });

    this.addCommand({
      id: 'ticktick-university-exchange-auth-code',
      name: 'Exchange TickTick auth code/URL',
      callback: async () => {
        new AuthCodeModal(this.app, async (input) => {
          await this.exchangeAuthCode(input);
        }).open();
      },
    });

    this.addCommand({
      id: 'ticktick-university-test-connection',
      name: 'Test TickTick API connection',
      callback: async () => {
        await this.testConnection();
      },
    });

    this.addCommand({
      id: 'ticktick-university-discover-projects',
      name: 'Discover TickTick projects and auto-select target',
      callback: async () => {
        await this.discoverAndSelectProject();
      },
    });

    this.addSettingTab(new TickTickUniversitySyncSettingTab(this.app, this));

    this.setupAutoSync();

    if (this.settings.syncOnStartup) {
      // fire-and-forget, but with error handling
      this.syncNow().catch((e) => {
        console.error('[TickTick University Sync] Startup sync failed:', e);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
          console.error('[TickTick University Sync] Auto-sync error:', e);
        }
      }, mins * 60 * 1000);
    }
  }

  private normalizeTag(tag: string): string {
    return String(tag || '').trim().replace(/^#/, '').toLowerCase();
  }

  private toStringArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') {
      return v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return [];
  }

  private extractCode(input: string): string {
    const raw = input.trim();
    if (!raw) throw new Error('Empty auth code input.');

    // full redirect URL
    if (raw.includes('://') || raw.includes('?')) {
      try {
        const url = new URL(raw);
        const code = url.searchParams.get('code');
        if (code) return code;
      } catch {
        // continue
      }
    }

    // fallback: treat as code
    return raw;
  }

  getOAuthAuthorizeUrl(): string {
    const q = new URLSearchParams({
      client_id: this.settings.clientId,
      scope: this.settings.scopes,
      state: `obsidian-${Date.now()}`,
      redirect_uri: this.settings.redirectUri,
      response_type: 'code',
    });
    return `${TICKTICK_OAUTH_AUTHORIZE}?${q.toString()}`;
  }

  openOAuthUrl() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice('Set TickTick Client ID + Client Secret first.');
      return;
    }
    const url = this.getOAuthAuthorizeUrl();
    window.open(url, '_blank');
    new Notice('Opened TickTick OAuth page. Authorize, then paste redirect URL/code back.');
  }

  private basicAuthHeader(): string {
    const raw = `${this.settings.clientId}:${this.settings.clientSecret}`;
    return `Basic ${btoa(raw)}`;
  }

  async exchangeAuthCode(input: string) {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice('Set TickTick Client ID + Client Secret first.');
      return;
    }

    const code = this.extractCode(input);

    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      scope: this.settings.scopes,
      redirect_uri: this.settings.redirectUri,
    });

    const res = await requestUrl({
      url: TICKTICK_OAUTH_TOKEN,
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      console.error('[TickTick University Sync] exchange code failed:', res.status, res.text);
      throw new Error(`Token exchange failed (${res.status}). Check client settings/redirect URI.`);
    }

    const data = res.json as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data?.access_token) throw new Error('No access_token in TickTick response.');

    this.settings.accessToken = data.access_token;
    this.settings.refreshToken = data.refresh_token ?? this.settings.refreshToken;
    this.settings.tokenExpiryMs = Date.now() + ((data.expires_in ?? 3600) * 1000 * 0.9);
    await this.saveSettings();

    new Notice('TickTick connected successfully.');
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) {
      throw new Error('No refresh token available. Reconnect TickTick.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.settings.refreshToken,
      scope: this.settings.scopes,
    });

    const res = await requestUrl({
      url: TICKTICK_OAUTH_TOKEN,
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      console.error('[TickTick University Sync] refresh failed:', res.status, res.text);
      throw new Error(`Token refresh failed (${res.status}).`);
    }

    const data = res.json as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data?.access_token) throw new Error('No access_token returned on refresh.');

    this.settings.accessToken = data.access_token;
    this.settings.refreshToken = data.refresh_token ?? this.settings.refreshToken;
    this.settings.tokenExpiryMs = Date.now() + ((data.expires_in ?? 3600) * 1000 * 0.9);
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

  private async ticktickRequest<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    await this.ensureAccessToken();

    const doRequest = async () =>
      requestUrl({
        url: `${TICKTICK_API_BASE}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${this.settings.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        throw: false,
      });

    let res = await doRequest();

    // one retry after refresh on 401
    if (res.status === 401 && this.settings.refreshToken) {
      await this.refreshAccessToken();
      res = await doRequest();
    }

    if (res.status < 200 || res.status >= 300) {
      console.error('[TickTick University Sync] API error:', method, path, res.status, res.text);
      throw new Error(`TickTick API ${method} ${path} failed (${res.status})`);
    }

    return (res.json ?? {}) as T;
  }

  async listProjects(): Promise<TickTickProject[]> {
    const projects = await this.ticktickRequest<TickTickProject[]>('/open/v1/project', 'GET');
    return (projects ?? []).filter((p) => !p.closed);
  }

  async discoverAndSelectProject() {
    const projects = await this.listProjects();
    if (!projects.length) {
      new Notice('No TickTick projects found.');
      return;
    }

    const wanted = this.settings.ticktickProjectName.trim().toLowerCase();
    let selected = projects.find((p) => p.name.toLowerCase() === wanted);

    if (!selected) {
      selected =
        projects.find((p) => ['university', 'school', 'study'].includes(p.name.toLowerCase())) ??
        projects.find((p) => p.name.toLowerCase() === 'inbox') ??
        projects[0];
    }

    this.settings.ticktickProjectId = selected.id;
    this.settings.ticktickProjectName = selected.name;
    await this.saveSettings();

    new Notice(`Selected TickTick project: ${selected.name}`);
  }

  async testConnection() {
    const projects = await this.listProjects();
    new Notice(`TickTick connected. Projects: ${projects.length}`);
  }

  private isCompletedStatus(statusRaw: unknown): boolean {
    const arr = this.toStringArray(statusRaw).map((s) => s.toLowerCase());
    const scalar = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : '';
    const joined = [...arr, scalar].join(' ');
    return ['completed', 'complete', 'done', 'finished'].some((k) => joined.includes(k));
  }

  private formatTickTickDate(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');

    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}${om}`;
  }

  private parseDueToTickTick(dueRaw: string): { isAllDay: boolean; dueDate: string; startDate?: string; timeZone?: string } {
    const raw = dueRaw.trim();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [y, m, d] = raw.split('-').map((x) => Number(x));
      const start = new Date(y, m - 1, d, 0, 0, 0);
      const end = new Date(y, m - 1, d, 23, 59, 0);
      return {
        isAllDay: true,
        startDate: this.formatTickTickDate(start),
        dueDate: this.formatTickTickDate(end),
        timeZone: tz,
      };
    }

    // normalize timezone suffix if +HHMM
    const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

    // YYYY-MM-DDTHH:mm[:ss][Z|±HH:mm]
    const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/);
    if (!m) {
      throw new Error(`Unsupported due format: ${dueRaw}`);
    }

    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const s = Number(m[6] ?? '0');
    const tzSuffix = m[7];

    const dt = tzSuffix
      ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2, '0')}${tzSuffix === 'Z' ? 'Z' : tzSuffix}`)
      : new Date(y, mo - 1, d, h, mi, s);

    return {
      isAllDay: false,
      dueDate: this.formatTickTickDate(dt),
      timeZone: tz,
    };
  }

  private getObsidianDeepLink(file: TFile): string {
    const vaultName = this.app.vault.getName();
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.path)}`;
  }

  private async collectCandidates(): Promise<SyncCandidate[]> {
    const candidates: SyncCandidate[] = [];
    const assignmentTag = this.normalizeTag(this.settings.assignmentTag);
    const examTag = this.normalizeTag(this.settings.examTag);

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      const tagsRaw = fm['tags'];
      const tags = this.toStringArray(tagsRaw).map((t) => this.normalizeTag(t));
      const isUniversity = tags.includes(assignmentTag) || tags.includes(examTag);
      if (!isUniversity) continue;

      const dueRaw = String((fm as Record<string, unknown>)[this.settings.dueField] ?? '').trim();
      if (!dueRaw) continue;

      const classNames = this.toStringArray((fm as Record<string, unknown>)[this.settings.classField]);
      const statusRaw = (fm as Record<string, unknown>)[this.settings.statusField];
      const taskId = String((fm as Record<string, unknown>)[this.settings.taskIdField] ?? '').trim() || undefined;
      const projectId = String((fm as Record<string, unknown>)[this.settings.projectIdField] ?? '').trim() || undefined;

      candidates.push({
        file,
        dueRaw,
        tags,
        classNames,
        statusRaw,
        taskId,
        projectId,
      });
    }

    return candidates;
  }

  private async ensureTargetProjectId(): Promise<string> {
    if (this.settings.ticktickProjectId) return this.settings.ticktickProjectId;

    await this.discoverAndSelectProject();
    if (!this.settings.ticktickProjectId) {
      throw new Error('No TickTick target project selected.');
    }
    return this.settings.ticktickProjectId;
  }

  private buildTaskPayload(candidate: SyncCandidate, projectId: string, existingId?: string): TickTickTaskPayload {
    const due = this.parseDueToTickTick(candidate.dueRaw);
    const classText = candidate.classNames.length ? `Class: ${candidate.classNames.join(', ')}` : 'Class: (not set)';
    const noteLink = this.getObsidianDeepLink(candidate.file);

    const contentLines = [
      classText,
      `Source: [${candidate.file.basename}](${noteLink})`,
      `Obsidian path: ${candidate.file.path}`,
    ];

    return {
      id: existingId,
      projectId,
      title: candidate.file.basename,
      content: contentLines.join('\n'),
      isAllDay: due.isAllDay,
      startDate: due.startDate,
      dueDate: due.dueDate,
      timeZone: due.timeZone,
      status: this.isCompletedStatus(candidate.statusRaw) ? 2 : 0,
    };
  }

  private async createTask(payload: TickTickTaskPayload): Promise<{ id: string; projectId: string }> {
    const created = await this.ticktickRequest<{ id: string; projectId: string }>(
      '/open/v1/task',
      'POST',
      payload,
    );
    return created;
  }

  private async updateTask(taskId: string, payload: TickTickTaskPayload): Promise<{ id: string; projectId: string }> {
    const body: TickTickTaskPayload = {
      ...payload,
      id: taskId,
    };

    const updated = await this.ticktickRequest<{ id: string; projectId: string }>(
      `/open/v1/task/${encodeURIComponent(taskId)}`,
      'POST',
      body,
    );
    return updated;
  }

  private async completeTask(projectId: string, taskId: string): Promise<void> {
    await this.ticktickRequest(
      `/open/v1/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
      'POST',
      {},
    );
  }

  private async updateFrontmatterTracking(file: TFile, taskId: string, projectId: string) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      (fm as Record<string, unknown>)[this.settings.taskIdField] = taskId;
      (fm as Record<string, unknown>)[this.settings.projectIdField] = projectId;
      (fm as Record<string, unknown>)[this.settings.syncedAtField] = new Date().toISOString();
    });
  }

  async syncNow() {
    const start = Date.now();
    const summary = {
      scanned: 0,
      synced: 0,
      created: 0,
      updated: 0,
      completed: 0,
      skippedCompletedNoTask: 0,
      failed: 0,
    };

    const failures: string[] = [];

    try {
      const projectIdDefault = await this.ensureTargetProjectId();
      const candidates = await this.collectCandidates();
      summary.scanned = candidates.length;

      for (const candidate of candidates) {
        try {
          const completed = this.isCompletedStatus(candidate.statusRaw);
          const projectId = candidate.projectId || projectIdDefault;

          if (completed && !candidate.taskId && !this.settings.includeCompletedWithoutTaskId) {
            summary.skippedCompletedNoTask += 1;
            continue;
          }

          const payload = this.buildTaskPayload(candidate, projectId, candidate.taskId);

          if (this.settings.dryRun) {
            summary.synced += 1;
            continue;
          }

          let currentTaskId = candidate.taskId;
          let currentProjectId = projectId;

          if (!currentTaskId) {
            const created = await this.createTask(payload);
            currentTaskId = created.id;
            currentProjectId = created.projectId || projectId;
            summary.created += 1;
          } else {
            const updated = await this.updateTask(currentTaskId, payload);
            currentProjectId = updated.projectId || projectId;
            summary.updated += 1;
          }

          if (completed && currentTaskId) {
            await this.completeTask(currentProjectId, currentTaskId);
            summary.completed += 1;
          }

          await this.updateFrontmatterTracking(candidate.file, currentTaskId!, currentProjectId);
          summary.synced += 1;
        } catch (e) {
          summary.failed += 1;
          failures.push(`${candidate.file.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const tookMs = Date.now() - start;
      new Notice(
        `TickTick sync done: scanned ${summary.scanned}, synced ${summary.synced}, created ${summary.created}, updated ${summary.updated}, completed ${summary.completed}, failed ${summary.failed} (${Math.round(tookMs / 1000)}s)`,
        8000,
      );

      if (failures.length) {
        console.error('[TickTick University Sync] Failures:', failures);
      }
    } catch (e) {
      console.error('[TickTick University Sync] Fatal sync error:', e);
      new Notice(`TickTick sync failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
      throw e;
    }
  }
}

class AuthCodeModal extends Modal {
  private onSubmit: (input: string) => Promise<void>;

  constructor(app: App, onSubmit: (input: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Paste TickTick auth code or full redirect URL' });
    const text = contentEl.createEl('textarea');
    text.style.width = '100%';
    text.style.minHeight = '100px';
    text.placeholder = 'https://localhost/?code=... or just the code';

    const btnRow = contentEl.createDiv({ cls: 'ticktick-sync-modal-btns' });
    const submit = btnRow.createEl('button', { text: 'Exchange' });
    submit.addEventListener('click', async () => {
      try {
        await this.onSubmit(text.value);
        this.close();
      } catch (e) {
        new Notice(e instanceof Error ? e.message : String(e));
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TickTickUniversitySyncSettingTab extends PluginSettingTab {
  plugin: TickTickUniversitySyncPlugin;

  constructor(app: App, plugin: TickTickUniversitySyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'TickTick University Sync' });

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('TickTick OpenAPI Client ID from developer.ticktick.com/manage')
      .addText((text) =>
        text
          .setPlaceholder('client id')
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Client Secret')
      .setDesc('Stored locally in plugin data.json')
      .addText((text) => {
        text
          .setPlaceholder('client secret')
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        return text;
      });

    new Setting(containerEl)
      .setName('Redirect URI')
      .setDesc('Must match redirect URI configured in TickTick developer app')
      .addText((text) =>
        text
          .setPlaceholder('https://localhost/')
          .setValue(this.plugin.settings.redirectUri)
          .onChange(async (value) => {
            this.plugin.settings.redirectUri = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Scopes')
      .setDesc('Default: tasks:read tasks:write')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.scopes)
          .onChange(async (value) => {
            this.plugin.settings.scopes = value.trim() || 'tasks:read tasks:write';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Open OAuth URL')
      .setDesc('Step 1: Open authorization page in browser')
      .addButton((btn) =>
        btn.setButtonText('Open').onClick(() => {
          this.plugin.openOAuthUrl();
        }),
      );

    new Setting(containerEl)
      .setName('Exchange auth code/URL')
      .setDesc('Step 2: Paste redirect URL or code after authorizing')
      .addButton((btn) =>
        btn.setButtonText('Exchange').onClick(() => {
          new AuthCodeModal(this.app, async (input) => {
            await this.plugin.exchangeAuthCode(input);
            this.display();
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName('Refresh token now')
      .setDesc('Manual refresh if needed')
      .addButton((btn) =>
        btn.setButtonText('Refresh').onClick(async () => {
          try {
            await this.plugin.refreshAccessToken();
            new Notice('Token refreshed.');
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Lists projects from TickTick OpenAPI')
      .addButton((btn) =>
        btn.setButtonText('Test').onClick(async () => {
          try {
            await this.plugin.testConnection();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    containerEl.createEl('h3', { text: 'Sync mapping' });

    new Setting(containerEl)
      .setName('Assignment tag')
      .addText((text) =>
        text.setValue(this.plugin.settings.assignmentTag).onChange(async (value) => {
          this.plugin.settings.assignmentTag = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Exam tag')
      .addText((text) =>
        text.setValue(this.plugin.settings.examTag).onChange(async (value) => {
          this.plugin.settings.examTag = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('TickTick target project (name)')
      .setDesc('Used for auto-selection if project ID is not set.')
      .addText((text) =>
        text.setValue(this.plugin.settings.ticktickProjectName).onChange(async (value) => {
          this.plugin.settings.ticktickProjectName = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('TickTick target project ID')
      .setDesc('Leave empty to auto-discover by project name.')
      .addText((text) =>
        text.setValue(this.plugin.settings.ticktickProjectId).onChange(async (value) => {
          this.plugin.settings.ticktickProjectId = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Discover projects + auto-select')
      .addButton((btn) =>
        btn.setButtonText('Discover').onClick(async () => {
          try {
            await this.plugin.discoverAndSelectProject();
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    new Setting(containerEl)
      .setName('Due field key')
      .addText((text) =>
        text.setValue(this.plugin.settings.dueField).onChange(async (value) => {
          this.plugin.settings.dueField = value.trim() || 'due';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Status field key')
      .addText((text) =>
        text.setValue(this.plugin.settings.statusField).onChange(async (value) => {
          this.plugin.settings.statusField = value.trim() || 'status';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Class field key')
      .addText((text) =>
        text.setValue(this.plugin.settings.classField).onChange(async (value) => {
          this.plugin.settings.classField = value.trim() || 'class';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('TickTick task ID field key')
      .addText((text) =>
        text.setValue(this.plugin.settings.taskIdField).onChange(async (value) => {
          this.plugin.settings.taskIdField = value.trim() || 'ticktick_task_id';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Include completed notes without existing task ID')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeCompletedWithoutTaskId).onChange(async (value) => {
          this.plugin.settings.includeCompletedWithoutTaskId = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync on startup')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-sync interval (minutes)')
      .setDesc('0 disables periodic sync.')
      .addText((text) =>
        text.setPlaceholder('0')
          .setValue(String(this.plugin.settings.autoSyncMinutes))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.autoSyncMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Dry run')
      .setDesc('Scans and evaluates, but does not call TickTick or edit frontmatter.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dryRun).onChange(async (value) => {
          this.plugin.settings.dryRun = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync now')
      .addButton((btn) =>
        btn.setButtonText('Run').setCta().onClick(async () => {
          try {
            await this.plugin.syncNow();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    const exp = this.plugin.settings.tokenExpiryMs
      ? new Date(this.plugin.settings.tokenExpiryMs).toLocaleString()
      : 'not set';
    containerEl.createEl('p', { text: `Token expiry: ${exp}` });
  }
}
