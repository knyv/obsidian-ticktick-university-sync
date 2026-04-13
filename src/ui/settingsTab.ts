import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { makeUniversityRule } from '../defaults';
import { PluginApi } from '../pluginApi';
import { CustomRulePreset, SyncRule, TickTickProject, TrackingMode } from '../types';
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
    'Open TickTick Developer Apps.',
    'Create/select an app and set Redirect URI to EXACTLY: https://localhost/',
    'Copy Client ID + Client Secret into Obsidian (this settings page).',
    'Open OAuth URL and approve access in browser.',
    'Copy final redirect URL from browser address bar.',
    'Exchange from Clipboard (fastest) or use Manual Exchange.',
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
    'Use one rule per context: Deadlines, Work items, Personal tasks.',
    'Each rule is grouped into: Match notes -> Project target -> Sync behavior -> Task formatting.',
    'Start with Dry run before real sync.',
  ].forEach((line) => ul.createEl('li', { text: line }));
}

function addPresetGuideBlock(containerEl: HTMLElement, plugin: PluginApi): void {
  const block = addInfoBlock(containerEl, 'Preset guide (what each preset does)');
  const ul = block.createEl('ul');

  for (const p of plugin.getBuiltInPresets()) {
    ul.createEl('li', {
      text: `${p.name}: ${p.description} (tags: ${p.tagsAny.join(', ') || 'none'}; due properties: ${p.dueFields.join(', ')})`,
    });
  }

  if (plugin.settings.customPresets.length) {
    block.createEl('p', { text: 'Saved custom presets:' });
    const custom = block.createEl('ul');
    plugin.settings.customPresets.forEach((p) => {
      custom.createEl('li', {
        text: `${p.name}: ${p.description} (tags: ${p.tagsAny.join(', ') || 'none'}; due properties: ${p.dueFields.join(', ')})`,
      });
    });
  }
}

function addFormattingGuideBlock(containerEl: HTMLElement, allowAllPropertyTokens: boolean): void {
  const block = addInfoBlock(containerEl, 'Task formatting help');
  const ul = block.createEl('ul');
  [
    'Templates control how title/content/description appear in TickTick.',
    'Press Enter in template textareas for real line breaks (recommended).',
    'Literal \\n is also supported and converted automatically.',
    'Start with a preset, then tweak template text.',
  ].forEach((line) => ul.createEl('li', { text: line }));

  const tokenBlock = addInfoBlock(containerEl, 'Template tokens reference');
  const builtIn = tokenBlock.createEl('ul');
  [
    '{{noteTitle}} = note filename without .md',
    '{{filePath}} = full vault-relative note path',
    '{{class}} = class field value from note properties',
    '{{obsidianLink}} = obsidian:// deep link to this note',
    '{{ruleName}} = current rule name',
    '{{dueRaw}} = raw due property value',
    '{{duePretty}} = formatted due date/time',
    '{{status}} = status property value',
    '{{tags}} = note tags as comma-separated text',
    '{{projectName}} = selected TickTick project name',
  ].forEach((line) => builtIn.createEl('li', { text: line }));

  const custom = tokenBlock.createEl('p');
  custom.setText(
    allowAllPropertyTokens
      ? 'Custom property tokens are enabled: you can use any note property as {{propertyName}} (example: {{priority}}, {{teacher}}).'
      : 'Custom property tokens are disabled: only built-in tokens above will resolve. Enable "Template token mode" in global settings to allow any {{propertyName}} token.',
  );
}

export class TickTickSyncSettingTab extends PluginSettingTab {
  plugin: PluginApi;
  private projects: TickTickProject[] = [];
  private showAdvanced = false;
  private presetRuleIndexInput = '';
  private presetNameInput = '';
  private presetDescriptionInput = '';
  private selectedCustomPresetId = '';
  private expandedRuleIds = new Set<string>();

  constructor(app: App, plugin: PluginApi) {
    super(app, plugin as never);
    this.plugin = plugin;
  }

  private async addRuleFromPreset(preset: 'deadlines' | 'personal-tasks' | 'work-items' | 'custom') {
    let rule: SyncRule;

    if (preset === 'custom') {
      const list = this.plugin.settings.customPresets;
      const custom =
        list.find((p) => p.id === this.selectedCustomPresetId) ??
        list[0];
      if (!custom) {
        new Notice('No custom presets yet. Save one first.');
        return;
      }
      rule = this.ruleFromPreset(custom);
    } else {
      const builtIn = this.plugin.getBuiltInPresets().find((p) => p.id === preset);
      if (!builtIn) throw new Error(`Preset not found: ${preset}`);
      rule = this.ruleFromPreset(builtIn);
    }

    this.plugin.settings.rules.push(rule);
    this.expandedRuleIds.add(rule.id);
    await this.plugin.saveSettings();
    this.display();
  }

  private async addBlankRule() {
    const n = this.plugin.settings.rules.length + 1;
    const rule = makeUniversityRule({
      id: makeRuleId('rule'),
      name: `New rule ${n}`,
      tagsAny: [],
      excludeTagsAny: [],
      dueFields: ['due', 'deadline'],
      targetProjectId: '',
      targetProjectName: this.plugin.settings.fallbackProjectName || 'Inbox',
    });

    this.plugin.settings.rules.push(rule);
    this.expandedRuleIds.add(rule.id);
    await this.plugin.saveSettings();
    this.display();
  }

  private ruleFromPreset(preset: CustomRulePreset): SyncRule {
    return makeUniversityRule({
      id: makeRuleId(preset.id),
      name: preset.name,
      tagsAny: [...preset.tagsAny],
      excludeTagsAny: [...preset.excludeTagsAny],
      dueFields: [...preset.dueFields],
      targetProjectName: preset.targetProjectName,
      syncMode: preset.syncMode,
    });
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

  private ensureRuleExpanded(ruleId: string) {
    if (!this.expandedRuleIds.size) {
      this.expandedRuleIds.add(ruleId);
    }
  }

  private ensureRuleExpansionState() {
    const ids = new Set(this.plugin.settings.rules.map((r) => r.id));
    for (const id of Array.from(this.expandedRuleIds)) {
      if (!ids.has(id)) this.expandedRuleIds.delete(id);
    }
    if (!this.expandedRuleIds.size && this.plugin.settings.rules.length) {
      this.expandedRuleIds.add(this.plugin.settings.rules[0].id);
    }
  }

  private renderRule(containerEl: HTMLElement, rule: SyncRule, idx: number) {
    this.ensureRuleExpanded(rule.id);

    const header = containerEl.createEl('div', { cls: 'ticktick-flow-rule-header' });
    const headerLeft = header.createEl('div', { cls: 'ticktick-flow-rule-header-left' });
    const isExpanded = this.expandedRuleIds.has(rule.id);

    const collapseBtn = headerLeft.createEl('button', {
      text: isExpanded ? '▾' : '▸',
      cls: 'clickable-icon',
    });
    collapseBtn.addEventListener('click', () => {
      if (this.expandedRuleIds.has(rule.id)) this.expandedRuleIds.delete(rule.id);
      else this.expandedRuleIds.add(rule.id);
      this.display();
    });

    headerLeft.createEl('h4', {
      text: `Rule ${idx + 1}: ${rule.name}`,
      cls: rule.enabled ? '' : 'ticktick-flow-rule-title-disabled',
    });

    const headerRight = header.createEl('div', { cls: 'ticktick-flow-rule-header-right' });
    const enabledLabel = headerRight.createEl('span', { text: rule.enabled ? 'Enabled' : 'Disabled' });
    enabledLabel.addClass(rule.enabled ? 'ticktick-flow-pill-enabled' : 'ticktick-flow-pill-disabled');

    const enabledToggle = headerRight.createEl('input') as HTMLInputElement;
    enabledToggle.type = 'checkbox';
    enabledToggle.checked = rule.enabled;
    enabledToggle.classList.add('ticktick-flow-inline-toggle');
    enabledToggle.addEventListener('change', async () => {
      rule.enabled = enabledToggle.checked;
      await this.plugin.saveSettings();
      this.display();
    });

    if (!isExpanded) return;

    containerEl.createEl('h5', { text: 'A) Match notes' });

    new Setting(containerEl)
      .setName('Rule name')
      .setDesc('Friendly name only (for your own clarity).')
      .addText((text) =>
        text.setValue(rule.name).onChange(async (value) => {
          rule.name = value.trim() || `Rule ${idx + 1}`;
          await this.plugin.saveSettings();
          this.display();
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
      .setName('Due properties (fallback order)')
      .setDesc('Comma-separated frontmatter property names. First non-empty property wins (example: due, deadline, exam_date).')
      .addText((text) =>
        text.setPlaceholder('due, deadline').setValue(listToCsv(rule.dueFields)).onChange(async (value) => {
          rule.dueFields = csvToList(value);
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h5', { text: 'B) Project target' });

    new Setting(containerEl)
      .setName('Target project (dropdown)')
      .setDesc('Select TickTick project for this rule (load projects first in Account Setup).')
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
    addFormattingGuideBlock(containerEl, this.plugin.settings.allowAllPropertyTokens);

    new Setting(containerEl)
      .setName('Formatting presets')
      .setDesc('Apply a starter template set, then edit below if needed.')
      .addButton((btn) =>
        btn.setButtonText('Clean').onClick(async () => {
          rule.titleTemplate = '{{noteTitle}}';
          rule.contentTemplate = `Due: {{duePretty}}
Class: {{class}}
Open note: {{obsidianLink}}`;
          rule.descTemplate = `Path: {{filePath}}
Tags: {{tags}}
Rule: {{ruleName}}`;
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Detailed').onClick(async () => {
          rule.titleTemplate = '{{noteTitle}} · {{duePretty}}';
          rule.contentTemplate = `Task: {{noteTitle}}
Due: {{duePretty}}
Class: {{class}}
Tags: {{tags}}
Open note: {{obsidianLink}}`;
          rule.descTemplate = `Status: {{status}}
Project: {{projectName}}
Path: {{filePath}}
Rule: {{ruleName}}`;
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
          const ok = window.confirm(`Delete rule "${rule.name}"? This cannot be undone.`);
          if (!ok) return;
          this.plugin.settings.rules = this.plugin.settings.rules.filter((r) => r.id !== rule.id);
          this.expandedRuleIds.delete(rule.id);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    this.ensureRuleExpansionState();

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

    const oauthWrap = containerEl.createEl('div', { cls: 'ticktick-flow-actions-grid' });

    const oauthStep1 = new Setting(oauthWrap).setName('Beginner path: step 1').setDesc('Open TickTick developer app settings');
    oauthStep1
      .addButton((btn) =>
        btn.setButtonText('Open TickTick Developer Apps').setClass('mod-cta').onClick(() => {
          this.plugin.openTickTickDeveloperPage();
        }),
      )
      .settingEl.addClass('ticktick-flow-action-row');

    const oauthStep2 = new Setting(oauthWrap).setName('Beginner path: step 4').setDesc('Open OAuth consent page in browser');
    oauthStep2
      .addButton((btn) =>
        btn.setButtonText('Open OAuth URL').onClick(() => {
          this.plugin.openOAuthUrl();
        }),
      )
      .settingEl.addClass('ticktick-flow-action-row');

    const oauthStep3 = new Setting(oauthWrap).setName('Beginner path: step 6').setDesc('Exchange redirect URL/code from clipboard');
    oauthStep3
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
      .settingEl.addClass('ticktick-flow-action-row');

    const oauthStep4 = new Setting(oauthWrap).setName('Beginner path: alternative').setDesc('If clipboard fails, paste manually');
    oauthStep4
      .addButton((btn) =>
        btn.setButtonText('Manual Exchange').onClick(() => {
          new AuthCodeModal(this.app, async (input) => {
            await this.plugin.exchangeAuthCode(input);
            this.display();
          }).open();
        }),
      )
      .settingEl.addClass('ticktick-flow-action-row');

    new Setting(containerEl)
      .setName('Connection & projects')
      .setDesc('Recommended: click "Load + test projects" first, then choose project per rule')
      .addButton((btn) =>
        btn.setButtonText('Load + test projects').setClass('mod-cta').onClick(async () => {
          try {
            await this.plugin.testConnection();
            await this.plugin.preloadProjects();
            this.projects = await this.plugin.listProjects();
            new Notice(`Ready: loaded ${this.projects.length} projects. Now select target project per rule.`);
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
      )
      .addButton((btn) =>
        btn.setButtonText('Manual: load project list').onClick(async () => {
          try {
            this.projects = await this.plugin.listProjects();
            new Notice(`Loaded ${this.projects.length} projects.`);
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
      .setName('Template token mode')
      .setDesc('Enable custom {{property}} tokens from note frontmatter in templates')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowAllPropertyTokens).onChange(async (value) => {
          this.plugin.settings.allowAllPropertyTokens = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

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

    containerEl.createEl('h4', { text: 'Add new rule' });

    const addRuleWrap = containerEl.createEl('div', { cls: 'ticktick-flow-add-rule-grid' });

    const addBlank = new Setting(addRuleWrap)
      .setName('Start from scratch')
      .setDesc('Create an empty rule with sensible defaults you can edit')
      .addButton((btn) =>
        btn.setButtonText('+ Create blank rule').setClass('mod-cta').onClick(async () => {
          await this.addBlankRule();
        }),
      );
    addBlank.settingEl.addClass('ticktick-flow-add-rule-row');

    const addDeadlines = new Setting(addRuleWrap)
      .setName('Preset: Deadlines')
      .setDesc('Due-date focused notes (generic)')
      .addButton((btn) =>
        btn.setButtonText('+ Add Deadlines rule').onClick(async () => {
          await this.addRuleFromPreset('deadlines');
        }),
      );
    addDeadlines.settingEl.addClass('ticktick-flow-add-rule-row');

    const addPersonal = new Setting(addRuleWrap)
      .setName('Preset: Personal tasks')
      .setDesc('Personal/home/admin style tasks')
      .addButton((btn) =>
        btn.setButtonText('+ Add Personal tasks rule').onClick(async () => {
          await this.addRuleFromPreset('personal-tasks');
        }),
      );
    addPersonal.settingEl.addClass('ticktick-flow-add-rule-row');

    const addWork = new Setting(addRuleWrap)
      .setName('Preset: Work items')
      .setDesc('Work/project related tasks')
      .addButton((btn) =>
        btn.setButtonText('+ Add Work items rule').onClick(async () => {
          await this.addRuleFromPreset('work-items');
        }),
      );
    addWork.settingEl.addClass('ticktick-flow-add-rule-row');

    const addCustom = new Setting(addRuleWrap)
      .setName('Preset: Custom (selected below)')
      .setDesc('Apply your selected saved custom preset')
      .addButton((btn) =>
        btn.setButtonText('+ Add selected custom preset').onClick(async () => {
          await this.addRuleFromPreset('custom');
        }),
      );
    addCustom.settingEl.addClass('ticktick-flow-add-rule-row');

    addPresetGuideBlock(containerEl, this.plugin);

    if (this.plugin.settings.customPresets.length > 0) {
      new Setting(containerEl)
        .setName('Select custom preset for "First custom preset" button')
        .setDesc('Choose which saved custom preset is applied when clicking the button')
        .addDropdown((d) => {
          const list = this.plugin.settings.customPresets;
          if (!this.selectedCustomPresetId || !list.find((p) => p.id === this.selectedCustomPresetId)) {
            this.selectedCustomPresetId = list[0].id;
          }
          list.forEach((p) => d.addOption(p.id, p.name));
          d.setValue(this.selectedCustomPresetId).onChange((value) => {
            this.selectedCustomPresetId = value;
          });
        });
    }

    if (this.plugin.settings.rules.length > 0) {
      new Setting(containerEl)
        .setName('Save current rule as custom preset')
        .setDesc('Pick a rule by index, then save reusable preset settings')
        .addText((text) =>
          text
            .setPlaceholder(`rule index, 1-${this.plugin.settings.rules.length}`)
            .setValue(this.presetRuleIndexInput)
            .onChange((value) => {
              this.presetRuleIndexInput = value;
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('preset name')
            .setValue(this.presetNameInput)
            .onChange((value) => {
              this.presetNameInput = value;
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('preset description')
            .setValue(this.presetDescriptionInput)
            .onChange((value) => {
              this.presetDescriptionInput = value;
            }),
        )
        .addButton((btn) =>
          btn.setButtonText('Save preset').onClick(async () => {
            const idxRaw = this.presetRuleIndexInput.trim() || '1';
            const name = this.presetNameInput.trim() || 'Custom preset';
            const description = this.presetDescriptionInput.trim() || 'Custom preset from current rule';

            const idx = Number(idxRaw) - 1;
            if (!Number.isFinite(idx) || idx < 0 || idx >= this.plugin.settings.rules.length) {
              new Notice(`Invalid rule index. Use 1-${this.plugin.settings.rules.length}.`);
              return;
            }

            await this.plugin.createCustomPresetFromRule(this.plugin.settings.rules[idx].id, name, description);
            this.presetRuleIndexInput = '';
            this.presetNameInput = '';
            this.presetDescriptionInput = '';
            this.display();
          }),
        );
    }


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

    containerEl.createEl('h3', { text: '4) Danger zone' });
    new Setting(containerEl)
      .setName('Reset plugin settings to defaults')
      .setDesc('Clears current rules/presets and restores default settings')
      .addButton((btn) =>
        btn.setWarning().setButtonText('Reset plugin settings').onClick(async () => {
          const ok = window.confirm('Reset TickTick Flow Sync settings to defaults? This will remove your current rules and custom presets.');
          if (!ok) return;
          await this.plugin.resetSettingsToDefault();
          this.projects = [];
          this.expandedRuleIds.clear();
          this.presetRuleIndexInput = '';
          this.presetNameInput = '';
          this.presetDescriptionInput = '';
          this.selectedCustomPresetId = '';
          this.display();
        }),
      );
  }
}
