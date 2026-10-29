import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { Settings } from '../settings/settings';
import type { Discovery, ProjectInfo, BuildTools, BuildEvent, BuildSelection, BuildResult } from '../build/types';

export interface FileSnapshot { path: string; uri: string; text: string; bom: boolean; revision: string }
export interface Entry { name: string; path: string; directory: boolean; symlink: boolean }
export interface Preferences { recentWorkspaces: string[]; recentFiles: string[]; settings: unknown }
export interface WatchEvent { paths: string[]; rescan: boolean; error: string | null }
export interface ToolInfo { path: string; version: string; source: 'bundled' | 'external' }
export const desktop = isTauri();
export const native = {
  preferences: () => invoke<Preferences>('load_preferences'),
  storeSettings: (settings: Settings) => invoke<void>('store_preferences', { settings }),
  chooseWorkspace: () => invoke<string | null>('choose_workspace'),
  activateWorkspace: (path: string) => invoke<string>('activate_workspace', { path }),
  recentWorkspace: (path: string) => invoke<string>('recent_workspace', { path }),
  chooseDocument: () => invoke<FileSnapshot | null>('choose_document'),
  rememberDocument: (path: string) => invoke<string[]>('remember_document', { path }),
  recentDocument: (path: string) => invoke<FileSnapshot>('recent_document', { path }),
  chooseLanguageServer: () => invoke<string | null>('choose_language_server'),
  read: (path: string) => invoke<FileSnapshot>('read_document', { path }),
  save: (path: string, text: string, bom: boolean, revision: string) => invoke<FileSnapshot>('save_document', { path, text, bom, revision }),
  saveAs: (text: string, bom: boolean, protectedPaths: string[]) => invoke<FileSnapshot | null>('save_document_as', { text, bom, protectedPaths }),
  entries: (path: string) => invoke<Entry[]>('list_directory', { path }),
  watch: (paths: string[], receive: (event: WatchEvent) => void) => invoke<void>('watch_start', { paths, onEvent: new Channel<WatchEvent>(receive) }),
  stopWatch: () => invoke<void>('watch_stop'),
  discoverProjects: () => invoke<Discovery>('discover_projects'),
  inspectProject: (path: string) => invoke<ProjectInfo>('inspect_project', { path }),
  buildTools: () => invoke<BuildTools>('build_tools'),
  chooseBuildTool: (compiler: boolean) => invoke<string | null>('choose_build_tool', { compiler }),
  previewProject: (entry: string, profile: string, includes: string[]) => invoke<string>('preview_project', { entry, profile, includes }),
  createProject: (text: string) => invoke<FileSnapshot>('create_project', { text }),
  buildProject: (selection: BuildSelection, receive: (event: BuildEvent) => void) => invoke<BuildResult>('build_project', { selection, onEvent: new Channel<BuildEvent>(receive) }),
  cancelBuild: (id: number) => invoke<void>('cancel_build', { id }),
};
