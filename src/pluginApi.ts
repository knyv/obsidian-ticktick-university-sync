import { App } from 'obsidian';
import { TickTickUniversitySyncSettings } from './types';

export interface PluginApi {
  app: App;
  settings: TickTickUniversitySyncSettings;
  saveSettings: () => Promise<void>;
  syncNow: () => Promise<void>;
  testConnection: () => Promise<void>;
  openOAuthUrl: () => void;
  exchangeAuthCode: (input: string) => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  discoverAndSelectProject: (ruleId?: string) => Promise<void>;
}
