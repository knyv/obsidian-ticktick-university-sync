import { App } from 'obsidian';
import { CustomRulePreset, TickTickProject, TickTickUniversitySyncSettings } from './types';

export interface PluginApi {
  app: App;
  settings: TickTickUniversitySyncSettings;
  saveSettings: () => Promise<void>;
  syncNow: () => Promise<void>;
  testConnection: () => Promise<void>;
  listProjects: () => Promise<TickTickProject[]>;
  preloadProjects: () => Promise<void>;
  openTickTickDeveloperPage: () => void;
  openOAuthUrl: () => void;
  exchangeAuthCode: (input: string) => Promise<void>;
  exchangeAuthCodeFromClipboard: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  discoverAndSelectProject: (ruleId?: string) => Promise<void>;
  getBuiltInPresets: () => CustomRulePreset[];
  createCustomPresetFromRule: (ruleId: string, name: string, description: string) => Promise<void>;
  resetSettingsToDefault: () => Promise<void>;
}
