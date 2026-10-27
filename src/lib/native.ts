import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Settings } from '../settings/settings';

export interface FileSnapshot { path: string; uri: string; text: string; bom: boolean; revision: string }
export interface Entry { name: string; path: string; directory: boolean; symlink: boolean }
export interface Preferences { recentWorkspaces: string[]; settings: unknown }
export const desktop = isTauri();
export const native = {
  preferences: () => invoke<Preferences>('load_preferences'),
  storeSettings: (settings: Settings) => invoke<void>('store_preferences', { settings }),
  chooseWorkspace: () => invoke<string | null>('choose_workspace'),
  activateWorkspace: (path: string) => invoke<string>('activate_workspace', { path }),
  recentWorkspace: (path: string) => invoke<string>('recent_workspace', { path }),
  chooseDocument: () => invoke<FileSnapshot | null>('choose_document'),
  read: (path: string) => invoke<FileSnapshot>('read_document', { path }),
  save: (path: string, text: string, bom: boolean, revision: string) => invoke<FileSnapshot>('save_document', { path, text, bom, revision }),
  saveAs: (text: string, bom: boolean, protectedPaths: string[]) => invoke<FileSnapshot | null>('save_document_as', { text, bom, protectedPaths }),
  entries: (path: string) => invoke<Entry[]>('list_directory', { path }),
};
