import type { Workbench, WorkbenchState } from "./workbench";
import { building } from "../build/types";
import { t, type TranslationKey } from "../lib/i18n";

export interface AppCommand {
  label: TranslationKey;
  shortcut?: string;
  enabled: boolean;
  run: () => unknown;
}

export interface CommandViews {
  settings: () => void;
  project: () => void;
  explorer: () => void;
  search: () => void;
  sourceControl: () => void;
  quickOpen: () => void;
  problems: () => void;
  symbols: (mode: "document" | "workspace") => void;
  build: () => void;
  buildOutput: () => void;
  palette: () => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  resetLayout: () => void;
}

/** Menus and the palette share command availability and execution. */
export function createCommands(
  state: WorkbenchState,
  workbench: Workbench,
  nativeReady: boolean,
  views: CommandViews
): AppCommand[] {
  const active = Boolean(state.active);
  const fileActive = Boolean(state.active?.startsWith("file:"));
  const pawnActive =
    fileActive &&
    /\.(pwn|inc)$/i.test(
      state.tabs.find((tab) => tab.uri === state.active)?.name ?? ""
    );
  const mutable = nativeReady && !state.mutationBusy;
  const busy = building(state.build);
  const commands: AppCommand[] = [];

  const add = (
    label: TranslationKey,
    enabled: boolean,
    run: () => unknown,
    shortcut?: string
  ) => {
    commands.push({ label, enabled, run, shortcut });
  };
  add("command.newFile", mutable, () => workbench.newFile(), "Ctrl+N");
  add("command.openFile", mutable, () => workbench.openFile(), "Ctrl+O");
  add(
    "command.openFolder",
    mutable && !busy,
    () => workbench.chooseFolder(),
    "Ctrl+K Ctrl+O"
  );
  add("command.save", active && mutable, () => workbench.save(), "Ctrl+S");
  add(
    "command.saveAs",
    active && mutable,
    () => workbench.save(undefined, true),
    "Ctrl+Shift+S"
  );
  add(
    "command.saveAll",
    active && mutable,
    () => workbench.saveAll(),
    "Ctrl+Alt+S"
  );
  add(
    "command.close",
    active && mutable,
    () => workbench.close(state.active!),
    "Ctrl+W"
  );
  add(
    "command.reopen",
    mutable && state.canReopen,
    () => workbench.reopen(),
    "Ctrl+Shift+T"
  );
  add("command.reload", fileActive && mutable, () => workbench.reload());
  add("command.quit", mutable, () => workbench.quit());
  for (const [label, id, shortcut] of [
    ["command.undo", "undo", "Ctrl+Z"],
    ["command.redo", "redo", "Ctrl+Y"],
    ["command.find", "actions.find", "Ctrl+F"],
    ["command.replace", "editor.action.startFindReplaceAction", "Ctrl+H"],
  ] as const)
    add(label, active, () => workbench.action(id), shortcut);
  for (const [label, id, shortcut, feature] of [
    [
      "command.format",
      "editor.action.formatDocument",
      "Shift+Alt+F",
      "formatting",
    ],
    ["command.codeActions", "editor.action.quickFix", "Ctrl+.", "codeActions"],
    [
      "command.definition",
      "editor.action.revealDefinition",
      "F12",
      "definition",
    ],
    [
      "command.references",
      "editor.action.goToReferences",
      "Shift+F12",
      "references",
    ],
    ["command.rename", "editor.action.rename", "F2", "rename"],
  ] as const)
    add(
      label,
      pawnActive && Boolean(state.languageFeatures?.[feature]),
      () => workbench.action(id),
      shortcut
    );
  add(
    "command.symbols",
    pawnActive && Boolean(state.languageFeatures?.symbols),
    () => views.symbols("document"),
    "Ctrl+Shift+O"
  );
  add(
    "command.workspaceSymbols",
    Boolean(state.languageFeatures?.workspaceSymbols),
    () => views.symbols("workspace"),
    "Ctrl+T"
  );
  add(
    "command.restartLanguage",
    mutable && Boolean(state.root || fileActive),
    () => workbench.restartLanguage()
  );
  add("command.settings", state.ready, views.settings, "Ctrl+,");
  add(
    "explorer.title",
    nativeReady && Boolean(state.root),
    views.explorer,
    "Ctrl+Shift+E"
  );
  add("search.title", true, views.search, "Ctrl+Shift+F");
  add("scm.title", state.ready, views.sourceControl, "Ctrl+Shift+G");
  add(
    "search.files",
    mutable && Boolean(state.root),
    views.quickOpen,
    "Ctrl+P"
  );
  add("command.problems", true, views.problems, "Ctrl+J");
  add(
    "build.command",
    mutable && Boolean(state.root) && !busy,
    views.build,
    "Ctrl+Shift+B"
  );
  add("build.cancel", busy, () => workbench.cancelBuild());
  add("project.title", mutable && Boolean(state.root) && !busy, views.project);
  add("build.output", true, views.buildOutput);
  add("command.focusEditor", active, () => workbench.focusEditor());
  add("command.toggleMinimap", state.ready, () =>
    workbench.settings({ minimap: !state.settings.minimap })
  );
  add("command.toggleWordWrap", state.ready, () =>
    workbench.settings({ wordWrap: !state.settings.wordWrap })
  );
  add("command.palette", state.ready, views.palette, "Ctrl+Shift+P");
  add("layout.toggleSidebar", state.ready, views.toggleSidebar, "Ctrl+B");
  add("layout.togglePanel", state.ready, views.togglePanel);
  add("layout.reset", state.ready, views.resetLayout);
  return commands;
}

export function filterCommands(
  commands: AppCommand[],
  query: string
): AppCommand[] {
  const words = query
    .trim()
    .replace(/^>/, "")
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return commands
    .filter((command) => {
      const text =
        `${t(command.label)} ${command.shortcut ?? ""}`.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((first, second) =>
      t(first.label).localeCompare(t(second.label), "en")
    );
}

export function executeCommand(
  command: AppCommand,
  report: (error: unknown) => void
): void {
  if (!command.enabled) return;
  try {
    void Promise.resolve(command.run()).catch(report);
  } catch (error) {
    report(error);
  }
}
