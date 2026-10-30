import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { GitRequest } from "../sourceControl/types";
import type { Settings } from "../settings/settings";
import type {
  TerminalEvent,
  TerminalInfo,
  ShellProfile,
} from "../terminal/types";
import type {
  Discovery,
  ProjectInfo,
  BuildTools,
  BuildEvent,
  BuildSelection,
  BuildResult,
} from "../build/types";
import type {
  SearchOptions,
  SearchOverlay,
  SearchResult,
} from "../search/types";

export interface FileSnapshot {
  path: string;
  uri: string;
  text: string;
  bom: boolean;
  revision: string;
}

export interface Entry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
}

export interface EntryMutation {
  source: string;
  path: string | null;
  recentFiles: string[] | null;
  warning: unknown | null;
}

export interface Preferences {
  recentWorkspaces: string[];
  recentFiles: string[];
  settings: unknown;
}

export interface WatchEvent {
  paths: string[];
  rescan: boolean;
  error: string | null;
}

export interface ToolInfo {
  path: string;
  version: string;
  source: "bundled" | "external";
}

export const desktop = isTauri();

export const native = {
  terminalShells: () => invoke<ShellProfile[]>("terminal_shells"),
  terminalStart: (
    shell: string,
    root: string | null,
    cols: number,
    rows: number,
    receive: (event: TerminalEvent) => void
  ) =>
    invoke<TerminalInfo>("terminal_start", {
      shell,
      root,
      cols,
      rows,
      onEvent: new Channel<TerminalEvent>(receive),
    }),
  terminalWrite: (id: number, data: number[]) =>
    invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: number, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  terminalAcknowledge: (id: number, sequence: number) =>
    invoke<void>("terminal_acknowledge", { id, sequence }),
  terminalClose: (id: number) => invoke<void>("terminal_close", { id }),
  terminalCloseAll: () => invoke<void>("terminal_close_all"),
  git: <T>(root: string, id: number, request: GitRequest) =>
    invoke<T>("git_request", { root, id, request }),
  cancelGit: (id: number) => invoke<void>("cancel_git", { id }),
  preferences: () => invoke<Preferences>("load_preferences"),
  storeSettings: (settings: Settings) =>
    invoke<void>("store_preferences", { settings }),
  chooseWorkspace: () => invoke<string | null>("choose_workspace"),
  activateWorkspace: (path: string) =>
    invoke<string>("activate_workspace", { path }),
  recentWorkspace: (path: string) =>
    invoke<string>("recent_workspace", { path }),
  chooseDocument: () => invoke<FileSnapshot | null>("choose_document"),
  rememberDocument: (path: string) =>
    invoke<string[]>("remember_document", { path }),
  recentDocument: (path: string) =>
    invoke<FileSnapshot>("recent_document", { path }),
  chooseLanguageServer: () => invoke<string | null>("choose_language_server"),
  read: (path: string) => invoke<FileSnapshot>("read_document", { path }),
  save: (path: string, text: string, bom: boolean, revision: string) =>
    invoke<FileSnapshot>("save_document", { path, text, bom, revision }),
  saveAs: (text: string, bom: boolean, protectedPaths: string[]) =>
    invoke<FileSnapshot | null>("save_document_as", {
      text,
      bom,
      protectedPaths,
    }),
  entries: (path: string) => invoke<Entry[]>("list_directory", { path }),
  watch: (paths: string[], receive: (event: WatchEvent) => void) =>
    invoke<void>("watch_start", {
      paths,
      onEvent: new Channel<WatchEvent>(receive),
    }),
  stopWatch: () => invoke<void>("watch_stop"),
  discoverProjects: () => invoke<Discovery>("discover_projects"),
  inspectProject: (path: string) =>
    invoke<ProjectInfo>("inspect_project", { path }),
  buildTools: () => invoke<BuildTools>("build_tools"),
  chooseBuildTool: () => invoke<string | null>("choose_build_tool"),
  previewProject: (entry: string, profile: string, includes: string[]) =>
    invoke<string>("preview_project", { entry, profile, includes }),
  createProject: (text: string) =>
    invoke<FileSnapshot>("create_project", { text }),
  buildProject: (
    selection: BuildSelection,
    receive: (event: BuildEvent) => void
  ) =>
    invoke<BuildResult>("build_project", {
      selection,
      onEvent: new Channel<BuildEvent>(receive),
    }),
  cancelBuild: (id: number) => invoke<void>("cancel_build", { id }),
  search: (
    id: number,
    options: SearchOptions,
    overlays: SearchOverlay[],
    replacement?: string
  ) =>
    invoke<SearchResult>("search_workspace", {
      id,
      options,
      overlays,
      replacement,
    }),
  cancelSearch: (id: number) => invoke<void>("cancel_search", { id }),
  createEntry: (parent: string, name: string, directory: boolean) =>
    invoke<string>("create_entry", { parent, name, directory }),
  renameEntry: (path: string, name: string) =>
    invoke<EntryMutation>("rename_entry", { path, name }),
  trashEntry: (path: string) => invoke<EntryMutation>("trash_entry", { path }),
};
