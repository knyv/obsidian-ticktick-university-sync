import { App } from 'obsidian';
import { TickTickProject, TickTickUniversitySyncSettings } from './types';

export interface PluginApi {
  app: App;
  settings: TickTickUniversitySyncSettings;
  saveSettings: () => Promise<void>;
  syncNow: () => Promise<void>;
  testConnection: () => Promise<void>;
  listProjects: () => Promise<TickTickProject[]>;
  openTickTickDeveloperPage: () => void;
  openOAuthUrl: () => void;
  exchangeAuthCode: (input: string) => Promise<void>;
  exchangeAuthCodeFromClipboard: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  discoverAndSelectProject: (ruleId?: string) => Promise<void>;
}
