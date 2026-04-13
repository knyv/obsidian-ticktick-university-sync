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

type ChecklistItem = { done: boolean; text: string };

function setupChecklist(plugin: PluginApi): { items: ChecklistItem[]; tokenExpiry: string } {
  const hasClient = Boolean(plugin.settings.clientId && plugin.settings.clientSecret);
  const hasToken = Boolean(plugin.settings.accessToken);
  const hasRule = plugin.settings.rules.length > 0;
  const hasProject = plugin.settings.rules.some((r) => r.targetProjectId || r.targetProjectName);

  return {
    items: [
      { done: hasClient, text: 'Add Client ID + Client Secret' },
      { done: hasToken, text: 'Connect OAuth (token saved)' },
      { done: hasRule, text: 'Create at least one rule' },
      { done: hasProject, text: 'Select a TickTick project' },
      { done: hasClient && hasToken && hasRule, text: 'Run Test API connection, then Sync now' },
    ],
    tokenExpiry: plugin.settings.tokenExpiryMs ? new Date(plugin.settings.tokenExpiryMs).toLocaleString() : 'not set',
  };
}

function addInfoBlock(containerEl: HTMLElement, title: string): HTMLElement {
  const block = containerEl.createEl('div', { cls: 'ticktick-flow-info' });
  block.createEl('h4', { text: title });
  return block;
}

function addChecklistBlock(containerEl: HTMLElement, plugin: PluginApi): void {
  const { items, tokenExpiry } = setupChecklist(plugin);
  const block = addInfoBlock(containerEl, 'Setup checklist');
  const ul = block.createEl('ul');
  items.forEach((item) => {
    ul.createEl('li', { text: `${item.done ? '✅' : '⬜'} ${item.text}` });
  });
  block.createEl('p', { text: `Token expiry: ${tokenExpiry}` });
}

function addOAuthGuideBlock(containerEl: HTMLElement): void {
  const block = addInfoBlock(containerEl, 'How to connect TickTick (beginner path)');
  const ol = block.createEl('ol');
  [
    'Click "Open TickTick Developer Apps".',
    'Create/select an app and set Redirect URI to EXACTLY: https://localhost/',
    'Copy Client ID + Client Secret into this page.',
    'Click "Open OAuth URL" and approve access in browser.',
    'Copy final redirect URL from browser address bar.',
    'Click "Exchange from Clipboard" (fastest) or use Manual Exchange.',
  ].forEach((step) => ol.createEl('li', { text: step }));
  block.createEl('p', {
    text: 'Important: Redirect URI must match exactly in BOTH places, including trailing slash.',
    cls: 'ticktick-flow-info-warning',
  });
}

function addRulesGuideBlock(containerEl: HTMLElement): void {
  const block = addInfoBlock(containerEl, 'How rules work');
  const ul = block.createEl('ul');
  [
    'A note matches when it has ANY include tag and NONE of the exclude tags.',
    'Due date uses the first non-empty key in Due fields list (left to right).',
    'Use one rule per context: University, Work, Personal.',
    'Each rule is grouped into: Match notes -> Project target -> Sync behavior -> Task formatting.',
    'Start with Dry run before real sync.',
  ].forEach((line) => ul.createEl('li', { text: line }));
}

function addFormattingGuideBlock(containerEl: HTMLElement): void {
  const block = addInfoBlock(containerEl, 'Task formatting help');
  const ul = block.createEl('ul');
  [
    'Title/content/description are optional templates sent to TickTick.',
    'Tokens supported: {{noteTitle}}, {{duePretty}}, {{class}}, {{obsidianLink}}, etc.',
    'Press Enter in the text box for real line breaks (recommended).',
    'Literal \\n is also supported and converted automatically.',
    'Use preset buttons first, then tweak.',
  ].forEach((line) => ul.createEl('li', { text: line }));
}

export class TickTickSyncSettingTab extends PluginSettingTab {
  plugin: PluginApi;
  private projects: TickTickProject[] = [];
  private showAdvanced = false;

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
    const options: Record<string, string> = { '': '(none selected)' };

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
    containerEl.createEl('h5', { text: 'A) Match notes' });

    new Setting(containerEl)
      .setName('Rule name')
      .setDesc('Friendly name only (for your own clarity).')
      .addText((text) =>
        text.setValue(rule.name).onChange(async (value) => {
          rule.name = value.trim() || `Rule ${idx + 1}`;
          await this.plugin.saveSettings();
        }),
      )
      .addToggle((toggle) =>
        toggle.setValue(rule.enabled).onChange(async (value) => {
          rule.enabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Include tags')
      .setDesc('Comma-separated. Note must contain at least one of these tags.')
      .addText((text) =>
        text.setPlaceholder('university/assignments, university/exams').setValue(listToCsv(rule.tagsAny)).onChange(async (value) => {
          rule.tagsAny = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Exclude tags')
      .setDesc('Comma-separated. Notes with these tags are skipped.')
      .addText((text) =>
        text.setPlaceholder('archive, someday').setValue(listToCsv(rule.excludeTagsAny)).onChange(async (value) => {
          rule.excludeTagsAny = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Due fields (fallback order)')
      .setDesc('Comma-separated keys. First non-empty key wins (example: due, deadline).')
      .addText((text) =>
        text.setValue(listToCsv(rule.dueFields)).onChange(async (value) => {
          rule.dueFields = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h5', { text: 'B) Project target' });

    new Setting(containerEl)
      .setName('Target project (dropdown)')
      .setDesc('Click "Load project list" in Account Setup first, then select here.')
      .addDropdown((d) => {
        const options = this.projectDropdownOptions(rule);
        Object.entries(options).forEach(([id, name]) => d.addOption(id, name));
        d.setValue(rule.targetProjectId || '').onChange(async (value) => {
          rule.targetProjectId = value;
          const selected = this.projects.find((p) => p.id === value);
          if (selected) rule.targetProjectName = selected.name;
          await this.plugin.saveSettings();
        });
      })
      .addButton((btn) =>
        btn.setButtonText('Auto-pick').onClick(async () => {
          try {
            await this.plugin.discoverAndSelectProject(rule.id);
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    containerEl.createEl('h5', { text: 'C) Sync behavior' });

    new Setting(containerEl)
      .setName('Sync mode')
      .setDesc('Upsert = create+update. Create only = never edit existing tasks.')
      .addDropdown((d) =>
        d
          .addOption('upsert', 'Upsert (recommended)')
          .addOption('create_only', 'Create only')
          .setValue(rule.syncMode)
          .onChange(async (value) => {
            rule.syncMode = value === 'create_only' ? 'create_only' : 'upsert';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Completion behavior')
      .setDesc('If enabled, completed notes can mark TickTick tasks done.')
      .addToggle((toggle) =>
        toggle.setValue(rule.markCompletedInTickTick).onChange(async (value) => {
          rule.markCompletedInTickTick = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h5', { text: 'D) Task formatting' });
    addFormattingGuideBlock(containerEl);

    new Setting(containerEl)
      .setName('Formatting presets')
      .setDesc('Apply a starter template set, then edit below if needed.')
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
      .setName('Task title template')
      .addText((text) =>
        text.setValue(rule.titleTemplate).onChange(async (value) => {
          rule.titleTemplate = value || '{{noteTitle}}';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task content template')
      .setDesc('Multi-line supported: press Enter for line breaks. \\n also works.')
      .addTextArea((text) =>
        text.setValue(rule.contentTemplate).onChange(async (value) => {
          rule.contentTemplate = value || 'Source: [{{noteTitle}}]({{obsidianLink}})';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task description template')
      .setDesc('Multi-line supported: press Enter for line breaks. \\n also works.')
      .addTextArea((text) =>
        text.setValue(rule.descTemplate || '').onChange(async (value) => {
          rule.descTemplate = value || '';
          await this.plugin.saveSettings();
        }),
      );

    if (this.showAdvanced) {
      containerEl.createEl('h5', { text: 'Advanced rule options' });

      new Setting(containerEl)
        .setName('Status field key')
        .setDesc('Frontmatter key used to detect completion status.')
        .addText((text) =>
          text.setValue(rule.statusField).onChange(async (value) => {
            rule.statusField = value.trim() || 'status';
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Class field key')
        .addText((text) =>
          text.setValue(rule.classField).onChange(async (value) => {
            rule.classField = value.trim() || 'class';
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Completed keywords')
        .setDesc('Comma-separated terms that count as completed.')
        .addText((text) =>
          text.setValue(listToCsv(rule.completedKeywords)).onChange(async (value) => {
            rule.completedKeywords = csvToList(value);
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Include completed notes without existing task ID')
        .addToggle((toggle) =>
          toggle.setValue(rule.includeCompletedWithoutTaskId).onChange(async (value) => {
            rule.includeCompletedWithoutTaskId = value;
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Manual project name')
        .setDesc('Used if no project ID selected.')
        .addText((text) =>
          text.setValue(rule.targetProjectName).onChange(async (value) => {
            rule.targetProjectName = value.trim() || 'University';
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Manual project ID')
        .setDesc('Optional fixed TickTick project ID.')
        .addText((text) =>
          text.setValue(rule.targetProjectId).onChange(async (value) => {
            rule.targetProjectId = value.trim();
            await this.plugin.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName('Frontmatter tracking keys')
        .setDesc('Only used when tracking mode = frontmatter')
        .addText((text) =>
          text.setPlaceholder('task id key').setValue(rule.taskIdField).onChange(async (value) => {
            rule.taskIdField = value.trim() || 'ticktick_task_id';
            await this.plugin.saveSettings();
          }),
        )
        .addText((text) =>
          text.setPlaceholder('project id key').setValue(rule.projectIdField).onChange(async (value) => {
            rule.projectIdField = value.trim() || 'ticktick_project_id';
            await this.plugin.saveSettings();
          }),
        )
        .addText((text) =>
          text.setPlaceholder('synced at key').setValue(rule.syncedAtField).onChange(async (value) => {
            rule.syncedAtField = value.trim() || 'ticktick_synced_at';
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Delete this rule')
      .setDesc('Removes this rule completely.')
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
    containerEl.createEl('p', { text: 'Beginner-friendly setup first. Advanced controls are optional.' });

    containerEl.createEl('h3', { text: '1) Connect your TickTick account' });
    addChecklistBlock(containerEl, this.plugin);
    addOAuthGuideBlock(containerEl);

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('From TickTick Developer Apps page')
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
      .setDesc('Use exactly: https://localhost/  (must match TickTick app)')
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
        btn.setButtonText('Use recommended').onClick(async () => {
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
            new Notice('Copy failed. Copy manually from field.');
          }
        }),
      );

    new Setting(containerEl)
      .setName('OAuth actions')
      .setDesc('Run these in order: Developer Apps -> OAuth -> Exchange')
      .addButton((btn) =>
        btn.setButtonText('Open TickTick Developer Apps').onClick(() => {
          this.plugin.openTickTickDeveloperPage();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Open OAuth URL').onClick(() => {
          this.plugin.openOAuthUrl();
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
      )
      .addButton((btn) =>
        btn.setButtonText('Manual Exchange').onClick(() => {
          new AuthCodeModal(this.app, async (input) => {
            await this.plugin.exchangeAuthCode(input);
            this.display();
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName('Connection checks')
      .setDesc('Use these to verify login and load project dropdown data')
      .addButton((btn) =>
        btn.setButtonText('Test API connection').onClick(async () => {
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
      )
      .addButton((btn) =>
        btn.setButtonText('Refresh token').onClick(async () => {
          try {
            await this.plugin.refreshAccessToken();
            new Notice('Token refreshed.');
            this.display();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    containerEl.createEl('h3', { text: '2) Sync behavior (global)' });

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
      .setDesc('Safe mode: evaluate only, do not create/update/complete tasks.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dryRun).onChange(async (value) => {
          this.plugin.settings.dryRun = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Tracking mode')
      .setDesc('Frontmatter = IDs in notes. Local JSON = IDs only in plugin file.')
      .addDropdown((d) =>
        d
          .addOption('frontmatter', 'Frontmatter (recommended)')
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
        .setDesc('Path inside vault for mapping note -> TickTick task IDs.')
        .addText((text) =>
          text.setValue(this.plugin.settings.localTrackingFile).onChange(async (value) => {
            this.plugin.settings.localTrackingFile = value.trim() || '.obsidian/plugins/ticktick-flow-sync/tracking.json';
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Run sync now')
      .addButton((btn) =>
        btn.setButtonText('Sync now').setCta().onClick(async () => {
          try {
            await this.plugin.syncNow();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    containerEl.createEl('h3', { text: '3) Rules (what gets synced)' });
    addRulesGuideBlock(containerEl);

    new Setting(containerEl)
      .setName('Create rule from preset')
      .setDesc('Start with one of these and edit as needed')
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

    new Setting(containerEl)
      .setName('Advanced mode')
      .setDesc('Show low-level rule keys and extra controls')
      .addToggle((toggle) =>
        toggle.setValue(this.showAdvanced).onChange(async (value) => {
          this.showAdvanced = value;
          this.display();
        }),
      );

    for (let i = 0; i < this.plugin.settings.rules.length; i += 1) {
      const ruleWrap = containerEl.createEl('div', { cls: 'ticktick-flow-rule' });
      this.renderRule(ruleWrap, this.plugin.settings.rules[i], i);
    }
  }
}
