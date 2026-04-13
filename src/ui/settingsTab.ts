import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { makeUniversityRule } from '../defaults';
import { PluginApi } from '../pluginApi';
import { SyncRule, TickTickProject, TrackingMode } from '../types';
import { makeRuleId } from '../utils';
import { AuthCodeModal } from './authCodeModal';

function csvToList(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function listToCsv(v: string[]): string {
  return (v ?? []).join(', ');
}

function setupStatusText(plugin: PluginApi): string {
  const hasClient = Boolean(plugin.settings.clientId && plugin.settings.clientSecret);
  const hasToken = Boolean(plugin.settings.accessToken);
  const hasRule = plugin.settings.rules.length > 0;
  const hasProject = plugin.settings.rules.some((r) => r.targetProjectId || r.targetProjectName);
  const exp = plugin.settings.tokenExpiryMs ? new Date(plugin.settings.tokenExpiryMs).toLocaleString() : 'not set';

  return [
    'Quick setup status:',
    `1) App keys: ${hasClient ? 'ok' : 'missing'}`,
    `2) OAuth token: ${hasToken ? 'ok' : 'missing'} (expiry: ${exp})`,
    `3) Rule configured: ${hasRule ? 'ok' : 'missing'}`,
    `4) Target project hint: ${hasProject ? 'ok' : 'missing'}`,
    `5) Ready to test sync: ${hasClient && hasToken && hasRule ? 'yes' : 'no'}`,
  ].join('\n');
}

function oauthHowToText(): string {
  return [
    'How to connect TickTick (2-3 minutes):',
    '1) Click "Open TickTick Developer Apps"',
    '2) Create/select app, then set Redirect URI to EXACTLY: https://localhost/',
    '3) Copy Client ID + Client Secret into this plugin',
    '4) Click "Open OAuth URL" and approve access',
    '5) Copy final redirect URL (or code)',
    '6) Click "Exchange from Clipboard" (or manual Exchange)',
    '',
    'Tip: Redirect URI must be identical in both places, including trailing slash.',
  ].join('\\n');
}

function rulesHowToText(): string {
  return [
    'How rules work:',
    '- A note is included if it has ANY include tag and NONE of the exclude tags.',
    '- Due date is read from the first non-empty field in Due fields list.',
    '- Sync mode upsert = create/update, create_only = only new tasks.',
    '- Use one rule per context (University, Work, Personal).',
    '- Use Dry run first when changing rules or templates.',
  ].join('\\n');
}

function addInfoBlock(containerEl: HTMLElement, text: string): void {
  const el = containerEl.createEl('div', { cls: 'ticktick-flow-info' });
  el.setText(text);
}

export class TickTickSyncSettingTab extends PluginSettingTab {
  plugin: PluginApi;
  private projects: TickTickProject[] = [];

  constructor(app: App, plugin: PluginApi) {
    super(app, plugin as never);
    this.plugin = plugin;
  }

  private async addRuleFromPreset(preset: 'university' | 'personal' | 'work') {
    let rule: SyncRule;
    if (preset === 'university') {
      rule = makeUniversityRule({ id: makeRuleId('university'), name: 'University' });
    } else if (preset === 'personal') {
      rule = makeUniversityRule({
        id: makeRuleId('personal'),
        name: 'Personal Tasks',
        tagsAny: ['tasks/personal'],
        targetProjectName: 'Inbox',
      });
    } else {
      rule = makeUniversityRule({
        id: makeRuleId('work'),
        name: 'Work',
        tagsAny: ['tasks/work'],
        targetProjectName: 'Work',
      });
    }

    this.plugin.settings.rules.push(rule);
    await this.plugin.saveSettings();
    this.display();
  }

  private projectDropdownOptions(rule: SyncRule): Record<string, string> {
    const options: Record<string, string> = {
      '': '(none selected)',
    };

    for (const p of this.projects) {
      options[p.id] = p.name;
    }

    if (rule.targetProjectId && !options[rule.targetProjectId]) {
      options[rule.targetProjectId] = `${rule.targetProjectName || 'Unknown'} (saved)`;
    }

    return options;
  }

  private renderRule(containerEl: HTMLElement, rule: SyncRule, idx: number) {
    containerEl.createEl('h4', { text: `Rule ${idx + 1}: ${rule.name}` });

    new Setting(containerEl)
      .setName('Rule name')
      .addText((text) =>
        text.setValue(rule.name).onChange(async (value) => {
          rule.name = value.trim() || `Rule ${idx + 1}`;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Enabled')
      .addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Include tags (any)')
      .setDesc('Comma separated. Note must contain at least one tag.')
      .addText((text) =>
        text.setValue(listToCsv(rule.tagsAny)).onChange(async (value) => {
          rule.tagsAny = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Exclude tags (any)')
      .setDesc('Comma separated. Skip notes matching these tags.')
      .addText((text) =>
        text.setValue(listToCsv(rule.excludeTagsAny)).onChange(async (value) => {
          rule.excludeTagsAny = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Due fields (fallback order)')
      .setDesc('Comma separated frontmatter keys. First non-empty is used.')
      .addText((text) =>
        text.setValue(listToCsv(rule.dueFields)).onChange(async (value) => {
          rule.dueFields = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Status field')
      .addText((text) =>
        text.setValue(rule.statusField).onChange(async (value) => {
          rule.statusField = value.trim() || 'status';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Class field')
      .addText((text) =>
        text.setValue(rule.classField).onChange(async (value) => {
          rule.classField = value.trim() || 'class';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task ID field')
      .setDesc('Used only when tracking mode is frontmatter')
      .addText((text) =>
        text.setValue(rule.taskIdField).onChange(async (value) => {
          rule.taskIdField = value.trim() || 'ticktick_task_id';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Project ID field')
      .setDesc('Used only when tracking mode is frontmatter')
      .addText((text) =>
        text.setValue(rule.projectIdField).onChange(async (value) => {
          rule.projectIdField = value.trim() || 'ticktick_project_id';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Synced-at field')
      .setDesc('Used only when tracking mode is frontmatter')
      .addText((text) =>
        text.setValue(rule.syncedAtField).onChange(async (value) => {
          rule.syncedAtField = value.trim() || 'ticktick_synced_at';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Target project name')
      .setDesc('Used for auto-select if ID is empty')
      .addText((text) =>
        text.setValue(rule.targetProjectName).onChange(async (value) => {
          rule.targetProjectName = value.trim() || 'University';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Target project (dropdown)')
      .setDesc('Load project list first, then select directly')
      .addDropdown((d) => {
        const options = this.projectDropdownOptions(rule);
        Object.entries(options).forEach(([id, name]) => d.addOption(id, name));
        d.setValue(rule.targetProjectId || '').onChange(async (value) => {
          rule.targetProjectId = value;
          const selected = this.projects.find((p) => p.id === value);
          if (selected) rule.targetProjectName = selected.name;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Target project ID')
      .setDesc('Optional fixed ID')
      .addText((text) =>
        text.setValue(rule.targetProjectId).onChange(async (value) => {
          rule.targetProjectId = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Discover project for this rule')
      .addButton((btn) =>
        btn.setButtonText('Discover').onClick(async () => {
          try {
            await this.plugin.discoverAndSelectProject(rule.id);
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    new Setting(containerEl)
      .setName('Sync mode')
      .setDesc('upsert = create/update. create_only = only create new tasks.')
      .addDropdown((d) =>
        d
          .addOption('upsert', 'Upsert')
          .addOption('create_only', 'Create only')
          .setValue(rule.syncMode)
          .onChange(async (value) => {
            rule.syncMode = value === 'create_only' ? 'create_only' : 'upsert';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Mark completed in TickTick')
      .addToggle((toggle) =>
        toggle.setValue(rule.markCompletedInTickTick).onChange(async (value) => {
          rule.markCompletedInTickTick = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Include completed notes without existing task id')
      .addToggle((toggle) =>
        toggle.setValue(rule.includeCompletedWithoutTaskId).onChange(async (value) => {
          rule.includeCompletedWithoutTaskId = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Completed keywords')
      .setDesc('Comma separated, matched case-insensitively against status')
      .addText((text) =>
        text.setValue(listToCsv(rule.completedKeywords)).onChange(async (value) => {
          rule.completedKeywords = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task title template')
      .setDesc('Tokens: {{noteTitle}}, {{duePretty}}, {{class}}, {{projectName}}, etc.')
      .addText((text) =>
        text.setValue(rule.titleTemplate).onChange(async (value) => {
          rule.titleTemplate = value || '{{noteTitle}}';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task content template')
      .setDesc('Tokens supported. Use \\n for line breaks.')
      .addTextArea((text) =>
        text.setValue(rule.contentTemplate).onChange(async (value) => {
          rule.contentTemplate = value || 'Source: [{{noteTitle}}]({{obsidianLink}})';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task description template (desc)')
      .setDesc('Optional long description field in TickTick. Same tokens.')
      .addTextArea((text) =>
        text.setValue(rule.descTemplate || '').onChange(async (value) => {
          rule.descTemplate = value || '';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Formatting preset')
      .setDesc('Apply ready-made formatting templates to this rule')
      .addButton((btn) =>
        btn.setButtonText('Clean').onClick(async () => {
          rule.titleTemplate = '{{noteTitle}}';
          rule.contentTemplate = '📅 Due: {{duePretty}}\\n📚 Class: {{class}}\\n🔗 {{obsidianLink}}';
          rule.descTemplate = 'Path: {{filePath}}\\nTags: {{tags}}\\nRule: {{ruleName}}';
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Detailed').onClick(async () => {
          rule.titleTemplate = '{{noteTitle}} · {{duePretty}}';
          rule.contentTemplate = '📌 {{noteTitle}}\\n📅 {{duePretty}}\\n📚 {{class}}\\n🏷 {{tags}}';
          rule.descTemplate = 'Status: {{status}}\\nProject: {{projectName}}\\nOpen: {{obsidianLink}}\\nPath: {{filePath}}\\nRule: {{ruleName}}';
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Delete this rule')
      .setDesc('Removes this rule from settings')
      .addButton((btn) =>
        btn.setWarning().setButtonText('Delete').onClick(async () => {
          this.plugin.settings.rules = this.plugin.settings.rules.filter((r) => r.id !== rule.id);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'TickTick Flow Sync' });

    containerEl.createEl('h3', { text: 'Quick setup wizard' });
    addInfoBlock(containerEl, setupStatusText(this.plugin));
    addInfoBlock(containerEl, oauthHowToText());

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('TickTick OpenAPI Client ID')
      .addText((text) =>
        text
          .setPlaceholder('client id')
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
            this.display();
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
            this.display();
          });
        text.inputEl.type = 'password';
        return text;
      });

    new Setting(containerEl)
      .setName('Redirect URI')
      .setDesc('Must exactly match your TickTick developer app. Default: https://localhost/')
      .addText((text) =>
        text
          .setPlaceholder('https://localhost/')
          .setValue(this.plugin.settings.redirectUri)
          .onChange(async (value) => {
            this.plugin.settings.redirectUri = value.trim() || 'https://localhost/';
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText('Use default').onClick(async () => {
          this.plugin.settings.redirectUri = 'https://localhost/';
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Copy').onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.plugin.settings.redirectUri || 'https://localhost/');
            new Notice('Redirect URI copied.');
          } catch {
            new Notice('Copy failed. Copy manually from the Redirect URI field.');
          }
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
      .setName('Open TickTick Developer Apps')
      .setDesc('Create/configure app at developer.ticktick.com and set redirect URI there')
      .addButton((btn) =>
        btn.setButtonText('Open').onClick(() => {
          this.plugin.openTickTickDeveloperPage();
        }),
      );

    new Setting(containerEl)
      .setName('Open OAuth URL')
      .setDesc('Step 1: authorize in browser')
      .addButton((btn) =>
        btn.setButtonText('Open').onClick(() => {
          this.plugin.openOAuthUrl();
        }),
      );

    new Setting(containerEl)
      .setName('Exchange auth code/URL')
      .setDesc('Step 2: paste redirect URL or code')
      .addButton((btn) =>
        btn.setButtonText('Exchange').onClick(() => {
          new AuthCodeModal(this.app, async (input) => {
            await this.plugin.exchangeAuthCode(input);
            this.display();
          }).open();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Exchange from Clipboard').onClick(async () => {
          try {
            await this.plugin.exchangeAuthCodeFromClipboard();
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
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
      .setName('Test API connection')
      .setDesc('Lists TickTick projects')
      .addButton((btn) =>
        btn.setButtonText('Test').onClick(async () => {
          try {
            await this.plugin.testConnection();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Load project list').onClick(async () => {
          try {
            this.projects = await this.plugin.listProjects();
            new Notice(`Loaded ${this.projects.length} projects.`);
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    containerEl.createEl('h3', { text: 'Global sync behavior' });

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
        text
          .setPlaceholder('0')
          .setValue(String(this.plugin.settings.autoSyncMinutes))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.autoSyncMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Dry run')
      .setDesc('Scans/evaluates without writing frontmatter or calling TickTick create/update/complete')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dryRun).onChange(async (value) => {
          this.plugin.settings.dryRun = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Tracking mode')
      .setDesc('frontmatter = write ids into notes. local_json = keep ids in plugin JSON store.')
      .addDropdown((d) =>
        d
          .addOption('frontmatter', 'Frontmatter')
          .addOption('local_json', 'Local JSON')
          .setValue(this.plugin.settings.trackingMode)
          .onChange(async (value) => {
            this.plugin.settings.trackingMode = value === 'local_json' ? 'local_json' : 'frontmatter';
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if ((this.plugin.settings.trackingMode as TrackingMode) === 'local_json') {
      new Setting(containerEl)
        .setName('Local tracking file')
        .setDesc('Path inside vault for task-id mapping JSON')
        .addText((text) =>
          text.setValue(this.plugin.settings.localTrackingFile).onChange(async (value) => {
            this.plugin.settings.localTrackingFile = value.trim() || '.obsidian/plugins/ticktick-flow-sync/tracking.json';
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Fallback project name')
      .setDesc('Used when a rule has no explicit project name')
      .addText((text) =>
        text.setValue(this.plugin.settings.fallbackProjectName).onChange(async (value) => {
          this.plugin.settings.fallbackProjectName = value.trim() || 'University';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Fallback project ID')
      .addText((text) =>
        text.setValue(this.plugin.settings.fallbackProjectId).onChange(async (value) => {
          this.plugin.settings.fallbackProjectId = value.trim();
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

    containerEl.createEl('h3', { text: 'Rules (scenario profiles)' });
    addInfoBlock(containerEl, rulesHowToText());

    new Setting(containerEl)
      .setName('Add rule')
      .setDesc('Start from a preset and then tweak fields')
      .addButton((btn) =>
        btn.setButtonText('University').onClick(async () => {
          await this.addRuleFromPreset('university');
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Personal').onClick(async () => {
          await this.addRuleFromPreset('personal');
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Work').onClick(async () => {
          await this.addRuleFromPreset('work');
        }),
      );

    for (let i = 0; i < this.plugin.settings.rules.length; i += 1) {
      const hr = containerEl.createEl('hr');
      hr.style.margin = '16px 0';
      this.renderRule(containerEl, this.plugin.settings.rules[i], i);
    }
  }
}
