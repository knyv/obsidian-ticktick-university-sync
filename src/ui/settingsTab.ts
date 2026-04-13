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
type SettingsPane = 'setup' | 'rules' | 'advanced';

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
    'Use one rule per context: Deadlines, Work items, Personal tasks, or General tasks.',
    'Each rule is grouped into: Match notes -> Project target -> Sync behavior -> Task formatting.',
    'Project target must be explicitly selected for each enabled rule.',
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
    'Title template sets task title (most important field).',
    'Content template maps to TickTick task content/body (primary recommended).',
    'Description template is optional/legacy and may not be visible in all TickTick clients.',
    'Templates support Markdown text. For links, prefer {{obsidianMdLink}}.',
    'Prefer content template for details to avoid ambiguity.',
    'Obsidian links may not open in every TickTick client; desktop/browser support varies.',
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
    '{{obsidianLink}} = raw obsidian:// URL (device/client support varies)',
    '{{obsidianMdLink}} = Markdown link to obsidian:// URL (recommended in content/desc)',
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
  private activePane: SettingsPane = 'setup';
  private expandedRuleIds = new Set<string>();
  private expansionInitialized = false;
  private presetEditorOpenByRuleId = new Set<string>();
  private advancedEditorOpenByRuleId = new Set<string>();
  private formattingEditorOpenByRuleId = new Set<string>();
  private matchingDetailsOpenByRuleId = new Set<string>();

  constructor(app: App, plugin: PluginApi) {
    super(app, plugin as never);
    this.plugin = plugin;
  }

  private async addRuleFromPreset(preset: 'deadlines' | 'personal-tasks' | 'work-items' | 'general-tasks') {
    const builtIn = this.plugin.getBuiltInPresets().find((p) => p.id === preset);
    if (!builtIn) throw new Error(`Preset not found: ${preset}`);

    const rule = this.ruleFromPreset(builtIn);
    this.plugin.settings.rules.push(rule);
    this.expandedRuleIds.clear();
    this.expandedRuleIds.add(rule.id);
    this.expansionInitialized = true;
    await this.plugin.saveSettings();
    this.display();
  }

  private async addRuleFromCustomPresetId(presetId: string) {
    const custom = this.plugin.settings.customPresets.find((p) => p.id === presetId);
    if (!custom) {
      new Notice('Custom preset not found.');
      return;
    }

    const rule = this.ruleFromPreset(custom);
    this.plugin.settings.rules.push(rule);
    this.expandedRuleIds.clear();
    this.expandedRuleIds.add(rule.id);
    this.expansionInitialized = true;
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
    this.expandedRuleIds.clear();
    this.expandedRuleIds.add(rule.id);
    this.expansionInitialized = true;
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
      requireDueDate: preset.requireDueDate ?? true,
      markCompletedInTickTick: preset.markCompletedInTickTick ?? true,
      includeCompletedWithoutTaskId: preset.includeCompletedWithoutTaskId ?? false,
      candidateSelectionMode: preset.candidateSelectionMode ?? 'all',
      dueWindowMode: preset.dueWindowMode ?? 'all',
      completedKeywords: Array.isArray(preset.completedKeywords) && preset.completedKeywords.length
        ? [...preset.completedKeywords]
        : ['completed', 'complete', 'done', 'finished'],
      titleTemplate: preset.titleTemplate || '{{noteTitle}}',
      contentTemplate: preset.contentTemplate || '',
      descTemplate: preset.descTemplate || '',
      ticktickTagsField: preset.ticktickTagsField || 'ticktick_tags',
      tagSourceMode: preset.tagSourceMode === 'include_tags' ? 'include_tags' : 'all_note_tags',
      fixedTickTickTags: Array.isArray(preset.fixedTickTickTags) ? [...preset.fixedTickTickTags] : [],
      statusField: preset.statusField || 'status',
      classField: preset.classField || 'class',
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
    if (!this.expansionInitialized) {
      this.expandedRuleIds.clear();
      this.expandedRuleIds.add(ruleId);
      this.expansionInitialized = true;
    }
  }

  private ensureRuleExpansionState() {
    const ids = new Set(this.plugin.settings.rules.map((r) => r.id));
    for (const id of Array.from(this.expandedRuleIds)) {
      if (!ids.has(id)) this.expandedRuleIds.delete(id);
    }
    if (!this.expansionInitialized && this.plugin.settings.rules.length) {
      this.expandedRuleIds.clear();
      this.expandedRuleIds.add(this.plugin.settings.rules[0].id);
      this.expansionInitialized = true;
    }
  }

  private renderRule(containerEl: HTMLElement, rule: SyncRule, idx: number) {
    this.ensureRuleExpanded(rule.id);

    const header = containerEl.createEl('div', { cls: 'ticktick-flow-rule-header' });
    const headerLeft = header.createEl('div', { cls: 'ticktick-flow-rule-header-left' });
    const isExpanded = this.expandedRuleIds.has(rule.id);

    const includeCount = rule.tagsAny.length;
    const hasProject = Boolean(rule.targetProjectId);
    const dueMode = rule.requireDueDate === false ? 'due optional' : 'due required';
    const summaryBits = [
      includeCount ? `${includeCount} include tag${includeCount > 1 ? 's' : ''}` : 'no include tags',
      hasProject ? 'project selected' : 'project missing',
      dueMode,
      rule.syncMode === 'upsert' ? 'upsert' : 'create-only',
    ];

    const missingParts: string[] = [];
    if (includeCount === 0) missingParts.push('include tags');
    if (!hasProject) missingParts.push('target project');

    const ready = rule.enabled && missingParts.length === 0;
    const statusText = !rule.enabled ? 'Rule disabled' : ready ? 'Ready to sync' : 'Needs setup';
    const statusDetail = !rule.enabled
      ? 'Turn Enabled on to sync this rule.'
      : ready
        ? 'All required fields are set.'
        : `Missing: ${missingParts.join(', ')}`;

    const collapseBtn = headerLeft.createEl('button', {
      text: isExpanded ? '▾' : '▸',
      cls: 'clickable-icon',
    });
    collapseBtn.addEventListener('click', () => {
      if (this.expandedRuleIds.has(rule.id)) this.expandedRuleIds.delete(rule.id);
      else this.expandedRuleIds.add(rule.id);
      this.display();
      setTimeout(() => {
        const all = Array.from(this.containerEl.querySelectorAll('.ticktick-flow-rule-header button.clickable-icon')) as HTMLButtonElement[];
        const btn = all[idx];
        if (btn) btn.focus();
      }, 0);
    });

    const titleEl = headerLeft.createEl('h4', {
      text: `Rule ${idx + 1}: ${rule.name}`,
      cls: rule.enabled ? '' : 'ticktick-flow-rule-title-disabled',
    });
    titleEl.createSpan({ text: `  ·  ${summaryBits.join(' · ')}`, cls: 'ticktick-flow-rule-summary-inline' });

    const headerRight = header.createEl('div', { cls: 'ticktick-flow-rule-header-right' });
    const enabledLabel = headerRight.createEl('span', { text: rule.enabled ? 'Enabled' : 'Disabled' });
    enabledLabel.addClass(rule.enabled ? 'ticktick-flow-pill-enabled' : 'ticktick-flow-pill-disabled');

    const readinessLabel = headerRight.createEl('span', { text: statusText });
    readinessLabel.addClass(!rule.enabled ? 'ticktick-flow-pill-disabled' : ready ? 'ticktick-flow-pill-ready' : 'ticktick-flow-pill-needs-setup');

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

    const quickStart = containerEl.createEl('div', { cls: 'ticktick-flow-rule-quickstart' });
    quickStart.createEl('p', { text: `Status: ${statusDetail}` });
    quickStart.createEl('p', { text: 'Quick setup (recommended order): 1) Include tags  2) Target project  3) Sync mode  4) Rule actions' });
    if (!hasProject && rule.enabled) {
      const fixRow = quickStart.createEl('div', { cls: 'ticktick-flow-rule-quickstart-actions' });
      const fixBtn = fixRow.createEl('button', { text: 'Fix this rule: load projects now' });
      fixBtn.classList.add('mod-cta');
      fixBtn.addEventListener('click', async () => {
        try {
          await this.plugin.preloadProjects();
          this.projects = await this.plugin.listProjects();
          new Notice('Projects loaded. Now select a target project in this rule.');
          this.display();
        } catch (e) {
          new Notice(e instanceof Error ? e.message : String(e));
        }
      });
    }

    containerEl.createEl('h5', { text: 'A) Basic setup' });

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
      .addText((text) => {
        text.setPlaceholder('university/assignments, university/exams').setValue(listToCsv(rule.tagsAny));
        let debounceTimer: number | null = null;
        text.inputEl.addEventListener('input', () => {
          if (debounceTimer) window.clearTimeout(debounceTimer);
          debounceTimer = window.setTimeout(async () => {
            rule.tagsAny = csvToList(text.inputEl.value);
            await this.plugin.saveSettings();
          }, 250);
        });
        text.inputEl.addEventListener('blur', async () => {
          if (debounceTimer) window.clearTimeout(debounceTimer);
          rule.tagsAny = csvToList(text.inputEl.value);
          await this.plugin.saveSettings();
          this.display();
        });
        return text;
      });

    const showMatchDetails = this.matchingDetailsOpenByRuleId.has(rule.id) || !this.plugin.settings.simpleMode;
    new Setting(containerEl)
      .setName('Matching details')
      .setDesc(showMatchDetails ? 'Include/exclude and due matching options are visible below.' : 'Hidden for focus. Open to tune exclude tags and due property fallback.')
      .addButton((btn) =>
        btn.setButtonText(showMatchDetails ? 'Hide matching details' : 'Matching details').onClick(() => {
          if (this.matchingDetailsOpenByRuleId.has(rule.id)) this.matchingDetailsOpenByRuleId.delete(rule.id);
          else this.matchingDetailsOpenByRuleId.add(rule.id);
          this.display();
        }),
      );

    if (showMatchDetails) {
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
    }

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

    const showRuleAdvanced = this.advancedEditorOpenByRuleId.has(rule.id) || (!this.plugin.settings.simpleMode && this.showAdvanced);

    if (showRuleAdvanced) {
      new Setting(containerEl)
        .setName('Require due date')
        .setDesc('If off, notes without due can still sync (general tasks mode).')
        .addToggle((toggle) =>
          toggle.setValue(rule.requireDueDate !== false).onChange(async (value) => {
            rule.requireDueDate = value;
            await this.plugin.saveSettings();
            this.display();
          }),
        );

      new Setting(containerEl)
        .setName('Which tasks to sync')
        .setDesc('All, only new (not tracked yet), or only existing (already tracked)')
        .addDropdown((d) =>
          d
            .addOption('all', 'All')
            .addOption('new_only', 'Only new')
            .addOption('existing_only', 'Only existing')
            .setValue(rule.candidateSelectionMode || 'all')
            .onChange(async (value) => {
              rule.candidateSelectionMode = value === 'new_only' || value === 'existing_only' ? value : 'all';
              await this.plugin.saveSettings();
              this.display();
            }),
        );

      new Setting(containerEl)
        .setName('Due-date window')
        .setDesc('Choose whether to sync overdue only, not-overdue only, or both')
        .addDropdown((d) =>
          d
            .addOption('all', 'All due dates')
            .addOption('overdue_only', 'Only already due (overdue)')
            .addOption('not_overdue_only', 'Only upcoming/not overdue')
            .setValue(rule.dueWindowMode || 'all')
            .onChange(async (value) => {
              rule.dueWindowMode = value === 'overdue_only' || value === 'not_overdue_only' ? value : 'all';
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

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
    const showFormatting = this.formattingEditorOpenByRuleId.has(rule.id) || !this.plugin.settings.simpleMode;

    new Setting(containerEl)
      .setName('Formatting section')
      .setDesc(showFormatting ? 'Formatting controls are visible below.' : 'Hidden for focus. Open when you want to customize task text/layout.')
      .addButton((btn) =>
        btn.setButtonText(showFormatting ? 'Hide formatting' : 'Customize formatting').onClick(() => {
          if (this.formattingEditorOpenByRuleId.has(rule.id)) this.formattingEditorOpenByRuleId.delete(rule.id);
          else this.formattingEditorOpenByRuleId.add(rule.id);
          this.display();
        }),
      );

    if (showFormatting) {
      if (!this.plugin.settings.simpleMode) addFormattingGuideBlock(containerEl, this.plugin.settings.allowAllPropertyTokens);

      new Setting(containerEl)
        .setName('Formatting presets')
        .setDesc('Apply a starter template set, then edit below if needed.')
        .addButton((btn) =>
          btn.setButtonText('Minimal').onClick(async () => {
            rule.titleTemplate = '{{noteTitle}}';
            rule.contentTemplate = '';
            rule.descTemplate = '';
            await this.plugin.saveSettings();
            this.display();
          }),
        )
        .addButton((btn) =>
          btn.setButtonText('Notes-focused').onClick(async () => {
            rule.titleTemplate = '{{noteTitle}}';
            rule.contentTemplate = `Open note: {{obsidianMdLink}}\nPath: {{filePath}}`;
            rule.descTemplate = '';
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
        .setDesc('Primary text field sent to TickTick. Markdown supported. Recommended for note links/details.')
        .addTextArea((text) =>
          text.setValue(rule.contentTemplate).onChange(async (value) => {
            rule.contentTemplate = value;
            await this.plugin.saveSettings();
          }),
        );

      if (!this.plugin.settings.simpleMode || this.showAdvanced || this.advancedEditorOpenByRuleId.has(rule.id)) {
        new Setting(containerEl)
          .setName('Task description template (legacy/optional)')
          .setDesc('Secondary text field (`desc`). Some TickTick clients may not show this clearly. Prefer content template.')
          .addTextArea((text) =>
            text.setValue(rule.descTemplate || '').onChange(async (value) => {
              rule.descTemplate = value || '';
              await this.plugin.saveSettings();
            }),
          );
      }

      new Setting(containerEl)
        .setName('TickTick tags field (optional)')
        .setDesc('Frontmatter property containing tags to add in TickTick (comma list or YAML array).')
        .addText((text) =>
          text
            .setPlaceholder('ticktick_tags')
            .setValue(rule.ticktickTagsField || 'ticktick_tags')
            .onChange(async (value) => {
              rule.ticktickTagsField = value.trim() || 'ticktick_tags';
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('TickTick tags source')
        .setDesc('Choose whether tags come from all note tags or only include-tags, plus optional ticktick_tags field')
        .addDropdown((d) =>
          d
            .addOption('all_note_tags', 'All note tags (recommended)')
            .addOption('include_tags', 'Only include-tags from this rule')
            .setValue(rule.tagSourceMode || 'all_note_tags')
            .onChange(async (value) => {
              rule.tagSourceMode = value === 'include_tags' ? 'include_tags' : 'all_note_tags';
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Fixed TickTick tags (optional)')
        .setDesc('Always add these TickTick tags for this rule (comma-separated). Example: focus, uni')
        .addText((text) =>
          text
            .setPlaceholder('focus, uni')
            .setValue(listToCsv(rule.fixedTickTickTags || []))
            .onChange(async (value) => {
              rule.fixedTickTickTags = csvToList(value);
              await this.plugin.saveSettings();
            }),
        );
    }

    if (this.advancedEditorOpenByRuleId.has(rule.id) || this.showAdvanced) {
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
      .setName('Rule actions')
      .setDesc('Save this exact rule as preset, duplicate it, tune advanced options, or delete it.')
      .addButton((btn) =>
        btn.setButtonText('Save as preset').onClick(() => {
          if (this.presetEditorOpenByRuleId.has(rule.id)) this.presetEditorOpenByRuleId.delete(rule.id);
          else this.presetEditorOpenByRuleId.add(rule.id);
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(this.matchingDetailsOpenByRuleId.has(rule.id) || !this.plugin.settings.simpleMode ? 'Hide matching' : 'Matching').onClick(() => {
          if (this.matchingDetailsOpenByRuleId.has(rule.id)) this.matchingDetailsOpenByRuleId.delete(rule.id);
          else this.matchingDetailsOpenByRuleId.add(rule.id);
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(this.formattingEditorOpenByRuleId.has(rule.id) || !this.plugin.settings.simpleMode ? 'Hide formatting' : 'Formatting').onClick(() => {
          if (this.formattingEditorOpenByRuleId.has(rule.id)) this.formattingEditorOpenByRuleId.delete(rule.id);
          else this.formattingEditorOpenByRuleId.add(rule.id);
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(this.advancedEditorOpenByRuleId.has(rule.id) ? 'Hide advanced' : 'Advanced').onClick(() => {
          if (this.advancedEditorOpenByRuleId.has(rule.id)) this.advancedEditorOpenByRuleId.delete(rule.id);
          else this.advancedEditorOpenByRuleId.add(rule.id);
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Duplicate').onClick(async () => {
          const copy = JSON.parse(JSON.stringify(rule)) as SyncRule;
          copy.id = makeRuleId('rule');
          copy.name = `${rule.name} copy`;
          this.plugin.settings.rules.splice(idx + 1, 0, copy);
          this.expandedRuleIds.add(copy.id);
          this.matchingDetailsOpenByRuleId.delete(copy.id);
          this.formattingEditorOpenByRuleId.delete(copy.id);
          this.advancedEditorOpenByRuleId.delete(copy.id);
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setWarning().setButtonText('Delete').onClick(async () => {
          const ok = window.confirm(`Delete rule \"${rule.name}\"? This cannot be undone.`);
          if (!ok) return;
          this.plugin.settings.rules = this.plugin.settings.rules.filter((r) => r.id !== rule.id);
          this.expandedRuleIds.delete(rule.id);
          this.presetEditorOpenByRuleId.delete(rule.id);
          this.advancedEditorOpenByRuleId.delete(rule.id);
          this.formattingEditorOpenByRuleId.delete(rule.id);
          this.matchingDetailsOpenByRuleId.delete(rule.id);
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.presetEditorOpenByRuleId.has(rule.id)) {
      const presetEditWrap = containerEl.createEl('div', { cls: 'ticktick-flow-preset-inline-editor' });
      const suggestedName = `${rule.name} preset`;
      const existing = this.plugin.settings.customPresets.find((p) => p.name.toLowerCase() === suggestedName.toLowerCase());
      const nameInput = presetEditWrap.createEl('input') as HTMLInputElement;
      nameInput.type = 'text';
      nameInput.placeholder = 'Preset name';
      nameInput.value = existing?.name || suggestedName;

      const descInput = presetEditWrap.createEl('input') as HTMLInputElement;
      descInput.type = 'text';
      descInput.placeholder = 'Preset description';
      descInput.value = existing?.description || `Custom preset from rule: ${rule.name}`;

      const actionRow = presetEditWrap.createEl('div', { cls: 'ticktick-flow-preset-inline-actions' });
      const saveBtn = actionRow.createEl('button', { text: 'Save new preset' });
      saveBtn.classList.add('mod-cta');
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) {
          new Notice('Preset name is required.');
          return;
        }
        const description = descInput.value.trim();
        await this.plugin.createCustomPresetFromRule(rule.id, name, description);
        this.presetEditorOpenByRuleId.delete(rule.id);
        this.display();
      });

      if (existing) {
        const overwriteBtn = actionRow.createEl('button', { text: 'Replace existing preset' });
        overwriteBtn.classList.add('mod-warning');
        overwriteBtn.addEventListener('click', async () => {
          const ok = window.confirm(`Replace preset \"${existing.name}\" with current rule config?`);
          if (!ok) return;
          await this.plugin.removeCustomPreset(existing.id);
          await this.plugin.createCustomPresetFromRule(rule.id, nameInput.value.trim() || suggestedName, descInput.value.trim());
          this.presetEditorOpenByRuleId.delete(rule.id);
          this.display();
        });
      }

      const cancelBtn = actionRow.createEl('button', { text: 'Cancel' });
      cancelBtn.addEventListener('click', () => {
        this.presetEditorOpenByRuleId.delete(rule.id);
        this.display();
      });
    }
  }

  private renderSetupPane(containerEl: HTMLElement) {
    containerEl.createEl('h3', { text: '1) Connect your TickTick account' });
    addChecklistBlock(containerEl, this.plugin);
    addOAuthGuideBlock(containerEl);

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('From TickTick Developer Apps page')
      .addText((text) =>
        text.setPlaceholder('client id').setValue(this.plugin.settings.clientId).onChange(async (value) => {
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
        text.setPlaceholder('https://localhost/').setValue(this.plugin.settings.redirectUri).onChange(async (value) => {
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
      );

    const oauthWrap = containerEl.createEl('div', { cls: 'ticktick-flow-actions-grid' });
    const oauthStep1 = new Setting(oauthWrap).setName('Beginner path: step 1').setDesc('Open TickTick developer app settings');
    oauthStep1
      .addButton((btn) =>
        btn.setButtonText('Open TickTick Developer Apps').setClass('mod-cta').onClick(() => this.plugin.openTickTickDeveloperPage()),
      )
      .settingEl.addClass('ticktick-flow-action-row');

    const oauthStep2 = new Setting(oauthWrap).setName('Beginner path: step 4').setDesc('Open OAuth consent page in browser');
    oauthStep2
      .addButton((btn) => btn.setButtonText('Open OAuth URL').onClick(() => this.plugin.openOAuthUrl()))
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
      .setDesc('Click "Load + test projects", then select project per enabled rule. Project preloading also runs automatically after startup with delay.')
      .addButton((btn) =>
        btn.setButtonText('Load + test projects').setClass('mod-cta').onClick(async () => {
          try {
            await this.plugin.testConnection();
            await this.plugin.preloadProjects();
            this.projects = await this.plugin.listProjects();
            new Notice(`Ready: loaded ${this.projects.length} projects. Now select target project per enabled rule.`);
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

    new Setting(containerEl)
      .setName('Run sync now')
      .setDesc('Quick manual sync from setup pane')
      .addButton((btn) =>
        btn.setButtonText('Sync now').setCta().onClick(async () => {
          try {
            await this.plugin.syncNow();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );
  }

  private renderRulesPane(containerEl: HTMLElement) {
    containerEl.createEl('h3', { text: '2) Rules (what gets synced)' });

    if (this.plugin.settings.rules.length === 0) {
      const empty = containerEl.createEl('div', { cls: 'ticktick-flow-empty-state' });
      empty.createEl('h4', { text: 'No rules yet' });
      empty.createEl('p', { text: 'Start with one rule, then customize later if needed.' });
      const row = empty.createEl('div', { cls: 'ticktick-flow-empty-state-actions' });
      const cta = row.createEl('button', { text: '+ Create first rule' });
      cta.classList.add('mod-cta');
      cta.addEventListener('click', async () => {
        await this.addBlankRule();
        this.activePane = 'rules';
        this.display();
      });

      const presetBtn = row.createEl('button', { text: '+ Add Deadlines rule' });
      presetBtn.addEventListener('click', async () => {
        await this.addRuleFromPreset('deadlines');
        this.activePane = 'rules';
        this.display();
      });
    } else if (!this.plugin.settings.simpleMode) {
      addRulesGuideBlock(containerEl);
    }

    containerEl.createEl('h4', { text: 'Add new rule' });
    const addRuleWrap = containerEl.createEl('div', { cls: 'ticktick-flow-add-rule-grid' });

    const addBlank = new Setting(addRuleWrap)
      .setName('Start from scratch')
      .setDesc('Create an empty rule with sensible defaults you can edit')
      .addButton((btn) =>
        btn.setButtonText('+ Create blank rule').setClass('mod-cta').onClick(async () => {
          await this.addBlankRule();
          this.advancedEditorOpenByRuleId.clear();
          this.formattingEditorOpenByRuleId.clear();
          this.matchingDetailsOpenByRuleId.clear();
        }),
      );
    addBlank.settingEl.addClass('ticktick-flow-add-rule-row');

    const addDeadlines = new Setting(addRuleWrap)
      .setName('Preset: Deadlines')
      .setDesc('Due-date focused notes (generic). For full control, use + Create blank rule.')
      .addButton((btn) => btn.setButtonText('+ Add Deadlines rule').onClick(async () => this.addRuleFromPreset('deadlines')));
    addDeadlines.settingEl.addClass('ticktick-flow-add-rule-row');

    const addPersonal = new Setting(addRuleWrap)
      .setName('Preset: Personal tasks')
      .setDesc('Personal/home/admin style tasks')
      .addButton((btn) => btn.setButtonText('+ Add Personal tasks rule').onClick(async () => this.addRuleFromPreset('personal-tasks')));
    addPersonal.settingEl.addClass('ticktick-flow-add-rule-row');

    const addWork = new Setting(addRuleWrap)
      .setName('Preset: Work items')
      .setDesc('Work/project related tasks')
      .addButton((btn) => btn.setButtonText('+ Add Work items rule').onClick(async () => this.addRuleFromPreset('work-items')));
    addWork.settingEl.addClass('ticktick-flow-add-rule-row');

    const addGeneral = new Setting(addRuleWrap)
      .setName('Preset: General tasks')
      .setDesc('General tasks mode (due date optional)')
      .addButton((btn) => btn.setButtonText('+ Add General tasks rule').onClick(async () => this.addRuleFromPreset('general-tasks')));
    addGeneral.settingEl.addClass('ticktick-flow-add-rule-row');

    if (!this.plugin.settings.simpleMode) {
      addPresetGuideBlock(containerEl, this.plugin);
    }

    if (this.plugin.settings.customPresets.length > 0) {
      const customWrap = containerEl.createEl('div', { cls: 'ticktick-flow-preset-manager' });
      customWrap.createEl('h4', { text: 'Apply saved custom preset' });
      this.plugin.settings.customPresets.forEach((preset) => {
        const row = new Setting(customWrap)
          .setName(preset.name)
          .setDesc(preset.description || 'No description')
          .addButton((btn) =>
            btn.setButtonText('Add rule from preset').onClick(async () => {
              await this.addRuleFromCustomPresetId(preset.id);
            }),
          );
        row.settingEl.addClass('ticktick-flow-add-rule-row');
      });
    }

    if (this.plugin.settings.rules.length > 0) {
      const presetManagerWrap = containerEl.createEl('div', { cls: 'ticktick-flow-preset-manager' });
      presetManagerWrap.createEl('h4', { text: 'Manage custom presets' });
      presetManagerWrap.createEl('p', { text: 'Delete presets you no longer need. Save/update from each rule card via Rule actions.' });


      if (this.plugin.settings.customPresets.length > 0) {
        this.plugin.settings.customPresets.forEach((preset) => {
          const row = new Setting(presetManagerWrap)
            .setName(`Preset: ${preset.name}`)
            .setDesc(preset.description || 'No description')
            .addButton((btn) =>
              btn.setButtonText('Delete').setWarning().onClick(async () => {
                const ok = window.confirm(`Delete custom preset "${preset.name}"?`);
                if (!ok) return;
                await this.plugin.removeCustomPreset(preset.id);
                this.display();
              }),
            );
          row.settingEl.addClass('ticktick-flow-add-rule-row');
        });
      }
    }

    if (!this.plugin.settings.simpleMode) {
      new Setting(containerEl)
        .setName('Advanced mode (rule details)')
        .addToggle((toggle) =>
          toggle.setValue(this.showAdvanced).onChange(async (value) => {
            this.showAdvanced = value;
            this.display();
          }),
        );
    } else {
      this.showAdvanced = false;
    }

    for (let i = 0; i < this.plugin.settings.rules.length; i += 1) {
      const ruleWrap = containerEl.createEl('div', { cls: 'ticktick-flow-rule' });
      this.renderRule(ruleWrap, this.plugin.settings.rules[i], i);
    }
  }

  private renderAdvancedPane(containerEl: HTMLElement) {
    containerEl.createEl('h3', { text: '3) Advanced & performance' });

    if (this.plugin.settings.simpleMode) {
      containerEl.createEl('p', { text: 'Simple mode is ON. These controls are optional; change only if needed.' });
    }

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Runs one delayed sync after startup if already connected')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      )
      .addText((text) =>
        text.setPlaceholder('startup sync delay ms (e.g. 6000)').setValue(String(this.plugin.settings.startupSyncDelayMs || 0)).onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.startupSyncDelayMs = Number.isFinite(n) && n >= 0 ? n : 6000;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-sync interval (minutes)')
      .setDesc('0 disables periodic sync.')
      .addText((text) =>
        text.setPlaceholder('0').setValue(String(this.plugin.settings.autoSyncMinutes)).onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.autoSyncMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Dry run')
      .setDesc('Evaluate only, do not write to TickTick.')
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
        .addText((text) =>
          text.setValue(this.plugin.settings.localTrackingFile).onChange(async (value) => {
            this.plugin.settings.localTrackingFile = value.trim() || '.obsidian/plugins/ticktick-flow-sync/tracking.json';
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Template token mode')
      .setDesc('Enable custom {{property}} tokens from note frontmatter')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowAllPropertyTokens).onChange(async (value) => {
          this.plugin.settings.allowAllPropertyTokens = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Startup project preload')
      .setDesc('Load project list automatically after startup (non-blocking)')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.preloadProjectsOnStartup).onChange(async (value) => {
          this.plugin.settings.preloadProjectsOnStartup = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.preloadProjectsDelayMs || 0)).onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.preloadProjectsDelayMs = Number.isFinite(n) && n >= 0 ? n : 3500;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task source marker')
      .setDesc('Append source text to task description')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.addSourceMarker).onChange(async (value) => {
          this.plugin.settings.addSourceMarker = value;
          await this.plugin.saveSettings();
        }),
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.sourceMarkerText).onChange(async (value) => {
          this.plugin.settings.sourceMarkerText = value || 'Created by TickTick Flow Sync';
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('h3', { text: 'Danger zone' });
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
          this.expansionInitialized = false;
          this.display();
        }),
      );
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    this.ensureRuleExpansionState();

    containerEl.createEl('h2', { text: 'TickTick Flow Sync' });
    containerEl.createEl('p', { text: 'Simple first. Pick a pane, get set up fast, customize later.' });

    new Setting(containerEl)
      .setName('Quick sync')
      .setDesc('Run a manual sync now')
      .addButton((btn) =>
        btn.setButtonText('Sync now').setCta().onClick(async () => {
          try {
            await this.plugin.syncNow();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    new Setting(containerEl)
      .setName('Simple mode')
      .setDesc('Beginner-first defaults and fewer visible controls')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.simpleMode).onChange(async (value) => {
          this.plugin.settings.simpleMode = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    const paneBar = containerEl.createEl('div', { cls: 'ticktick-flow-pane-bar' });
    const panes: Array<{ id: SettingsPane; label: string }> = [
      { id: 'setup', label: 'Setup' },
      { id: 'rules', label: 'Rules' },
      { id: 'advanced', label: 'Advanced' },
    ];
    panes.forEach((pane) => {
      const btn = paneBar.createEl('button', { text: pane.label, cls: this.activePane === pane.id ? 'mod-cta' : '' });
      btn.addEventListener('click', () => {
        this.activePane = pane.id;
        this.display();
      });
    });

    if (this.activePane === 'setup') this.renderSetupPane(containerEl);
    else if (this.activePane === 'rules') this.renderRulesPane(containerEl);
    else this.renderAdvancedPane(containerEl);
  }
}
