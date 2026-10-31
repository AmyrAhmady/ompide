import { WindowControls } from "./components/WindowControls";
import { TerminalPanel, type TerminalActions } from "./terminal/TerminalPanel";
import { ActivityBar } from "./components/ActivityBar";
import { SourceControlPanel } from "./sourceControl/SourceControlPanel";
import { GitDiffView } from "./sourceControl/GitDiffView";
import type { OpenGitDiff } from "./sourceControl/types";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { Uri } from "monaco-editor";
import { workbench, type SymbolResult } from "./app/workbench";
import { desktop } from "./lib/native";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Explorer } from "./explorer/Explorer";
import { t } from "./lib/i18n";
import { Menubar, Menu, MenuItem } from "./components/Menubar";
import { Modal } from "./components/Modal";
import { EncodingDialog } from "./editor/EncodingDialog";
import { encodingLabel } from "./editor/text-files";
import { CommandPalette } from "./components/CommandPalette";
import { Splitter } from "./components/Splitter";
import { defaultLayout, parseLayout, type Layout } from "./settings/layout";
import {
  createCommands,
  executeCommand,
  type AppCommand,
} from "./app/commands";
import type { TranslationKey } from "./lib/i18n";
import { ProjectDialog } from "./build/ProjectDialog";
import { BuildPanel } from "./build/BuildPanel";
import { building } from "./build/types";
import {
  SearchPanel,
  QuickOpen,
  initialSearchFields,
} from "./search/SearchPanel";
import { selectedTheme, themeVariables } from "./settings/theme";
import { ThemeSettings } from "./settings/ThemeSettings";
import type { Settings } from "./settings/settings";
import toolPins from "../toolchain/tools.json";
import "./App.css";

const run = (operation: () => Promise<unknown>) => {
  void operation().catch(workbench.report);
};

function CommandMenuItem({ command }: { command: AppCommand }) {
  return (
    <MenuItem
      label={command.label}
      shortcut={command.shortcut}
      disabled={!command.enabled}
      action={() => executeCommand(command, workbench.report)}
    />
  );
}

function SettingsDialog({
  settings,
  tool,
  close,
}: {
  settings: Settings;
  tool?: { path: string; version: string };
  close: () => void;
}) {
  const update = (patch: Partial<Settings>) =>
    run(() => workbench.settings(patch));
  return (
    <Modal label={t("settings.title")} onCancel={close}>
      <h2>{t("settings.title")}</h2>
      <div className="settings-fields">
        <label>
          {t("settings.theme")}
          <select
            aria-label={t("settings.theme")}
            value={settings.theme}
            onChange={(event) =>
              update({
                theme:
                  event.target.value === "custom" && settings.customTheme
                    ? "custom"
                    : event.target.value === "light"
                      ? "light"
                      : "dark",
              })
            }
          >
            <option value="dark">{t("settings.dark")}</option>
            <option value="light">{t("settings.light")}</option>
            {settings.customTheme && (
              <option value="custom">
                {t("theme.customOption", { name: settings.customTheme.name })}
              </option>
            )}
          </select>
        </label>
        <ThemeSettings settings={settings} />
        <label>
          {t("settings.fontFamily")}
          <input
            value={settings.fontFamily}
            onChange={(event) => update({ fontFamily: event.target.value })}
          />
        </label>
        <label>
          {t("settings.fontSize")}
          <input
            type="number"
            min="8"
            max="48"
            value={settings.fontSize}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 8 && value <= 48) update({ fontSize: value });
            }}
          />
        </label>
        <label>
          {t("settings.tabSize")}
          <input
            type="number"
            min="1"
            max="8"
            value={settings.tabSize}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 1 && value <= 8) update({ tabSize: value });
            }}
          />
        </label>
        {(["insertSpaces", "wordWrap", "minimap", "formatOnSave"] as const).map(
          (key) => (
            <label className="checkbox" key={key}>
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(event) => update({ [key]: event.target.checked })}
              />
              {t(`settings.${key}`)}
            </label>
          )
        )}
        <fieldset>
          <legend>{t("settings.languageServer")}</legend>
          <p>
            {t("settings.languageServerVersion", {
              version: toolPins.tools.find((tool) => tool.name === "pawnlsp")!
                .version,
            })}
          </p>
          <p className="tool-path">
            {settings.languageServerPath || t("settings.bundledTool")}
          </p>
          {tool && (
            <p className="tool-path">
              {t("settings.activeTool", {
                version: tool.version,
                path: tool.path,
              })}
            </p>
          )}
          <div className="settings-tool-actions">
            <button
              type="button"
              onClick={() => run(() => workbench.configureLanguageServer())}
            >
              {t("settings.chooseLanguageServer")}
            </button>
            <button
              type="button"
              disabled={!settings.languageServerPath}
              onClick={() => run(() => workbench.configureLanguageServer(true))}
            >
              {t("settings.useBundled")}
            </button>
          </div>
        </fieldset>
      </div>
      <footer>
        <button type="button" onClick={close}>
          {t("command.dismiss")}
        </button>
      </footer>
    </Modal>
  );
}

function SymbolsDialog({
  mode,
  close,
}: {
  mode: "document" | "workspace";
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const title = t(
    mode === "document" ? "command.symbols" : "command.workspaceSymbols"
  );
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void (
        mode === "document"
          ? workbench.documentSymbols(query)
          : workbench.workspaceSymbols(query)
      )
        .then((results) => {
          if (live) {
            setResults(results);
            setSelected(0);
            setLoading(false);
          }
        })
        .catch((error) => {
          if (live) {
            setLoading(false);
            workbench.report(error);
          }
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
      workbench.cancelSymbols();
    };
  }, [query, mode]);

  const open = (symbol: SymbolResult) => {
    close();
    run(() => workbench.openUri(symbol.uri, symbol.line, symbol.column));
  };
  return (
    <Modal label={title} onCancel={close}>
      <h2>{title}</h2>
      <input
        className="symbol-query"
        autoFocus
        maxLength={256}
        aria-label={t(
          mode === "document" ? "symbols.documentQuery" : "symbols.query"
        )}
        role="combobox"
        aria-expanded="true"
        aria-controls="workspace-symbols"
        aria-activedescendant={
          results.length ? `workspace-symbol-${selected}` : undefined
        }
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) =>
              results.length
                ? (index +
                    (event.key === "ArrowDown" ? 1 : results.length - 1)) %
                  results.length
                : 0
            );
          }
          if (event.key === "Enter" && results[selected]) {
            event.preventDefault();
            open(results[selected]);
          }
        }}
      />
      <div
        className="symbol-results"
        role="listbox"
        id="workspace-symbols"
        aria-label={title}
        aria-busy={loading}
      >
        {results.map((symbol, index) => (
          <button
            type="button"
            role="option"
            id={`workspace-symbol-${index}`}
            aria-selected={selected === index}
            key={`${symbol.uri}:${symbol.line}:${symbol.column}:${index}`}
            title={symbol.uri}
            onClick={() => open(symbol)}
          >
            <span>{symbol.name}</span>
            <small>
              {symbol.container ?? Uri.parse(symbol.uri).path.split("/").at(-1)}
            </small>
          </button>
        ))}
      </div>
      <p className="muted" role="status">
        {t(
          loading
            ? "symbols.loading"
            : results.length
              ? "symbols.limit"
              : "symbols.empty"
        )}
      </p>
      <footer>
        <button type="button" onClick={close}>
          {t("command.dismiss")}
        </button>
      </footer>
    </Modal>
  );
}

function App() {
  const state = useSyncExternalStore(
    workbench.subscribe,
    workbench.getSnapshot
  );
  const container = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const terminal = useRef<TerminalActions>(null);
  const [terminalControls, setTerminalControls] =
    useState<HTMLDivElement | null>(null);
  const [gitDiff, setGitDiff] = useState<OpenGitDiff>();
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [encodingTarget, setEncodingTarget] = useState<string>();
  const [symbolsOpen, setSymbolsOpen] = useState<
    "document" | "workspace" | undefined
  >();
  const [projectOpen, setProjectOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchFields, setSearchFields] = useState(initialSearchFields);
  const [treeRevision, setTreeRevision] = useState(0);
  const [explorerReveal, setExplorerReveal] = useState(0);
  const layout = state.settings.layout;
  const problemsOpen = layout.panelVisible && layout.panel === "problems";
  const buildOpen = layout.panelVisible && layout.panel === "build";
  const terminalOpen = layout.panelVisible && layout.panel === "terminal";
  const searchOpen = layout.sidebar === "search";

  const refreshExplorer = useCallback(
    () => setTreeRevision((value) => value + 1),
    []
  );

  const configureProject = useCallback(() => setProjectOpen(true), []);

  const focusMain = useCallback(
    () =>
      requestAnimationFrame(() => {
        if (workbench.getSnapshot().active) workbench.focusEditor();
        else
          shell.current
            ?.querySelector<HTMLElement>(".ide-menubar summary")
            ?.focus();
      }),
    []
  );

  const changeLayout = useCallback((patch: Partial<Layout>) => {
    const snapshot = workbench.getSnapshot();
    if (!snapshot.ready) return;
    const next = parseLayout({ ...snapshot.settings.layout, ...patch });
    if (
      (Object.keys(defaultLayout) as (keyof Layout)[]).every(
        (key) => next[key] === snapshot.settings.layout[key]
      )
    )
      return;
    run(() => workbench.settings({ layout: next }));
  }, []);

  const setPanel = useCallback(
    (
      kind: Layout["panel"],
      update: boolean | ((visible: boolean) => boolean)
    ) => {
      const current = workbench.getSnapshot().settings.layout;
      const visible = current.panelVisible && current.panel === kind;
      const next = typeof update === "function" ? update(visible) : update;
      if (next) changeLayout({ panel: kind, panelVisible: true });
      else if (current.panel === kind) {
        const inside = panel.current?.contains(document.activeElement);
        changeLayout({ panelVisible: false });
        if (inside || document.activeElement === document.body) focusMain();
      }
    },
    [changeLayout, focusMain]
  );

  const setProblemsOpen = useCallback(
    (update: boolean | ((visible: boolean) => boolean)) =>
      setPanel("problems", update),
    [setPanel]
  );

  const setBuildOpen = useCallback(
    (update: boolean | ((visible: boolean) => boolean)) =>
      setPanel("build", update),
    [setPanel]
  );

  const showTerminal = () => {
    setPanel("terminal", true);
    requestAnimationFrame(() => terminal.current?.focus());
  };

  const newTerminal = () => {
    showTerminal();
    terminal.current?.create();
  };

  const setSearchOpen = useCallback(
    (update: boolean | ((search: boolean) => boolean)) => {
      const current =
        workbench.getSnapshot().settings.layout.sidebar === "search";
      const search = typeof update === "function" ? update(current) : update;
      changeLayout({
        sidebar: search ? "search" : "explorer",
        sidebarVisible: true,
      });
    },
    [changeLayout]
  );

  const toggleSidebar = () => {
    const visible = !workbench.getSnapshot().settings.layout.sidebarVisible;
    const inside =
      sidebar.current?.contains(document.activeElement) ||
      shell.current?.querySelector(".pane-resizer.vertical") ===
        document.activeElement;
    changeLayout({ sidebarVisible: visible });
    if (!visible && (inside || document.activeElement === document.body))
      focusMain();
  };

  const showSourceControl = () => {
    changeLayout({ sidebar: "sourceControl", sidebarVisible: true });
    requestAnimationFrame(() =>
      sidebar.current
        ?.querySelector<HTMLButtonElement>(".source-control button")
        ?.focus()
    );
  };

  useEffect(() => setGitDiff(undefined), [state.root]);

  const showSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() =>
      sidebar.current
        ?.querySelector<HTMLInputElement>("[data-search-query]")
        ?.focus()
    );
  };

  const showExplorer = useCallback(() => {
    setSearchOpen(false);
    setExplorerReveal((value) => value + 1);
  }, [setSearchOpen]);

  const togglePanel = () => {
    const current = workbench.getSnapshot().settings.layout;
    setPanel(current.panel, !current.panelVisible);
  };

  const resetLayout = () => {
    changeLayout(defaultLayout);
    focusMain();
  };
  const active = Boolean(state.active);
  const external = state.tabs.find((tab) => tab.uri === state.active)?.external;
  const connected = state.languagePhase === "ready";
  const nativeReady = desktop && state.ready;
  const activeTitle = state.tabs.find((tab) => tab.uri === state.active);
  const encodingDocument = state.tabs.find((tab) => tab.uri === encodingTarget);
  const windowTitle = [
    activeTitle ? `${activeTitle.dirty ? "● " : ""}${activeTitle.name}` : "",
    state.root?.split(/[\\/]/).at(-1),
    t("app.name"),
  ]
    .filter(Boolean)
    .join(" — ");
  useEffect(() => {
    document.title = windowTitle;
    if (desktop)
      void getCurrentWindow().setTitle(windowTitle).catch(workbench.report);
  }, [windowTitle]);
  const buildBusy = building(state.build);

  const startBuild = () => {
    if (!state.project) {
      setProjectOpen(true);
      return;
    }
    setBuildOpen(true);
    setProblemsOpen(false);
    run(() => workbench.buildProject());
  };
  const registeredCommands = createCommands(state, workbench, nativeReady, {
    settings: () => setSettingsOpen(true),
    encoding: () => setEncodingTarget(state.active),
    openEncoding: () => setEncodingTarget("open"),
    project: configureProject,
    explorer: showExplorer,
    search: showSearch,
    sourceControl: showSourceControl,
    quickOpen: () => setQuickOpen(true),
    problems: () => setProblemsOpen((value) => !value),
    symbols: setSymbolsOpen,
    build: startBuild,
    buildOutput: () => {
      setBuildOpen(true);
      setProblemsOpen(false);
    },
    palette: () => setCommandOpen(true),
    toggleSidebar,
    togglePanel,
    resetLayout,
    terminal: () => {
      if (terminalOpen) setPanel("terminal", false);
      else showTerminal();
    },
    newTerminal,
  });

  const command = (label: TranslationKey) =>
    registeredCommands.find((entry) => entry.label === label)!;
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    if (container.current)
      void workbench
        .mount(container.current)
        .then((dispose) => {
          if (disposed) dispose();
          else cleanup = dispose;
        })
        .catch(workbench.report);
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  useEffect(() => {
    let chordUntil = 0;

    const handle = (event: KeyboardEvent) => {
      if (
        state.prompt ||
        commandOpen ||
        settingsOpen ||
        symbolsOpen ||
        projectOpen ||
        quickOpen ||
        document.querySelector("dialog[open]")
      )
        return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        changeLayout({ sidebar: "sourceControl", sidebarVisible: true });
        return;
      }
      if (modifier && event.key.toLowerCase() === "w" && gitDiff) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setGitDiff(undefined);
        workbench.focusEditor();
        return;
      }
      let operation: (() => Promise<unknown>) | undefined;
      const key = event.key.toLowerCase();
      if (event.key === "F1" || (modifier && event.shiftKey && key === "p")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (state.ready) setCommandOpen(true);
        return;
      }
      if (modifier && event.code === "Backquote") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) newTerminal();
        else if (terminalOpen) setPanel("terminal", false);
        else showTerminal();
        return;
      }
      if (modifier && key === "j") {
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePanel();
        return;
      }
      // Terminal editing keys (Ctrl+C, Ctrl+W, Ctrl+K, etc.) belong to the shell.
      if (
        event.target instanceof Element &&
        event.target.closest(".terminal-panel")
      )
        return;
      if (modifier && key === "k") {
        chordUntil = Date.now() + 1500;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (Date.now() < chordUntil && key === "o")
        operation = () => workbench.chooseFolder();
      else if (modifier && key === "p") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (nativeReady && state.root) setQuickOpen(true);
        return;
      } else if (modifier && event.shiftKey && key === "e") {
        event.preventDefault();
        event.stopImmediatePropagation();
        showExplorer();
        return;
      } else if (modifier && event.shiftKey && key === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        showSearch();
        return;
      } else if (modifier && event.shiftKey && key === "b") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (nativeReady && state.root && !buildBusy) startBuild();
        return;
      } else if (modifier && event.shiftKey && key === "o") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (state.languageFeatures?.symbols) setSymbolsOpen("document");
        return;
      } else if (modifier && key === "o")
        operation = () => workbench.openFile();
      else if (modifier && key === "n") operation = () => workbench.newFile();
      else if (modifier && key === "s")
        operation = event.altKey
          ? () => workbench.saveAll()
          : () => workbench.save(undefined, event.shiftKey);
      else if (modifier && key === "w" && state.active)
        operation = () => workbench.close(state.active!);
      else if (modifier && event.shiftKey && key === "t")
        operation = () => workbench.reopen();
      else if (modifier && key === ",") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSettingsOpen(true);
        return;
      } else if (modifier && key === "b") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleSidebar();
        return;
      } else if (modifier && key === "t") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (state.languageFeatures?.workspaceSymbols)
          setSymbolsOpen("workspace");
        return;
      }
      if (operation && nativeReady) {
        event.preventDefault();
        event.stopImmediatePropagation();
        run(operation);
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [
    state.active,
    state.ready,
    commandOpen,
    state.prompt,
    state.languageFeatures,
    state.root,
    state.project,
    buildBusy,
    nativeReady,
    settingsOpen,
    symbolsOpen,
    projectOpen,
    quickOpen,
    gitDiff,
    terminalOpen,
  ]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      // Native close can clear buffers before React commits its next render.
      // Consult the current document state so an old closure cannot veto a confirmed exit.
      if (workbench.getSnapshot().tabs.some((tab) => tab.dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);

  return (
    <main
      ref={shell}
      className="workbench"
      style={
        {
          ...themeVariables(selectedTheme(state.settings)),
          colorScheme: selectedTheme(state.settings).base,
          "--sidebar-width": `${layout.sidebarWidth}px`,
          "--panel-height": `${layout.panelHeight}px`,
        } as CSSProperties
      }
    >
      <header className="ide-menubar" data-tauri-drag-region>
        <span className="app-mark" aria-label={t("app.name")}>
          ♟
        </span>
        <Menubar label={t("app.name")}>
          <Menu label="menu.file">
            <CommandMenuItem command={command("command.newFile")} />
            <CommandMenuItem command={command("command.openFile")} />
            <CommandMenuItem command={command("command.openWithEncoding")} />
            <CommandMenuItem command={command("command.openFolder")} />
            <hr />
            <CommandMenuItem command={command("command.save")} />
            <CommandMenuItem command={command("command.saveAs")} />
            <CommandMenuItem command={command("command.encoding")} />
            <CommandMenuItem command={command("command.saveAll")} />
            <hr />
            <CommandMenuItem command={command("command.close")} />
            <CommandMenuItem command={command("command.reopen")} />
            <CommandMenuItem command={command("command.reload")} />
            {state.recentFiles.length > 0 && (
              <>
                <hr />
                <span className="menu-heading">{t("recent.files")}</span>
                {state.recentFiles.slice(0, 5).map((path) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={path}
                    title={path}
                    disabled={!command("command.openFile").enabled}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      run(() => workbench.recentFile(path));
                    }}
                  >
                    {path.split(/[\\/]/).at(-1)}
                  </button>
                ))}
              </>
            )}
            <hr />
            <CommandMenuItem command={command("command.quit")} />
          </Menu>
          <Menu label="menu.edit">
            {(
              [
                "command.undo",
                "command.redo",
                "command.find",
                "command.replace",
                "command.format",
                "command.codeActions",
              ] as const
            ).map((label) => (
              <CommandMenuItem key={label} command={command(label)} />
            ))}
          </Menu>
          <Menu label="menu.view">
            <CommandMenuItem command={command("command.palette")} />
            <CommandMenuItem command={command("explorer.title")} />
            <CommandMenuItem command={command("command.problems")} />
            <CommandMenuItem command={command("command.settings")} />
            <CommandMenuItem command={command("search.title")} />
            <CommandMenuItem command={command("scm.title")} />
            <CommandMenuItem command={command("terminal.toggle")} />
            <CommandMenuItem command={command("search.files")} />
            <CommandMenuItem command={command("layout.toggleSidebar")} />
            <CommandMenuItem command={command("layout.togglePanel")} />
            <CommandMenuItem command={command("layout.reset")} />
          </Menu>
          <Menu label="menu.go">
            {(
              [
                "command.definition",
                "command.references",
                "command.rename",
              ] as const
            ).map((label) => (
              <CommandMenuItem key={label} command={command(label)} />
            ))}
            <CommandMenuItem command={command("command.symbols")} />
            <CommandMenuItem command={command("command.workspaceSymbols")} />
            <CommandMenuItem command={command("command.restartLanguage")} />
          </Menu>
          <Menu label="menu.build">
            <CommandMenuItem command={command("build.command")} />
            <CommandMenuItem command={command("build.cancel")} />
            <CommandMenuItem command={command("project.title")} />
            <CommandMenuItem command={command("build.output")} />
          </Menu>
          <Menu label="menu.terminal">
            <CommandMenuItem command={command("terminal.new")} />
            <CommandMenuItem command={command("terminal.toggle")} />
          </Menu>
        </Menubar>
        <span className="window-title" data-tauri-drag-region>
          {windowTitle}
        </span>
        <WindowControls />
      </header>
      {state.error && (
        <div className="error-banner" role="alert">
          <span>{state.error}</span>
          <button
            type="button"
            onClick={workbench.dismissError}
            aria-label={t("command.dismiss")}
          >
            ×
          </button>
        </div>
      )}
      <div className="workspace-body">
        <ActivityBar
          layout={layout}
          ready={state.ready}
          select={(view) => {
            const visible = layout.sidebar !== view || !layout.sidebarVisible;
            changeLayout({ sidebar: view, sidebarVisible: visible });
            if (visible)
              requestAnimationFrame(() =>
                sidebar.current
                  ?.querySelector<HTMLElement>("button, input")
                  ?.focus()
              );
            else focusMain();
          }}
        />
        <aside
          id="workspace-sidebar"
          className="explorer"
          ref={sidebar}
          hidden={!layout.sidebarVisible}
        >
          <SourceControlPanel
            root={state.root}
            ready={state.ready}
            visible={
              layout.sidebarVisible && layout.sidebar === "sourceControl"
            }
            openDiff={setGitDiff}
          />
          {layout.sidebar === "sourceControl" ? null : searchOpen ? (
            <SearchPanel
              root={state.root}
              fields={searchFields}
              change={setSearchFields}
              close={showExplorer}
            />
          ) : (
            <>
              <Explorer
                key={state.root ?? "empty"}
                root={state.root}
                active={state.active}
                revision={treeRevision + state.treeVersion}
                reveal={explorerReveal}
                busy={state.mutationBusy || buildBusy}
                refresh={refreshExplorer}
              />
            </>
          )}
        </aside>
        {layout.sidebarVisible && (
          <Splitter
            vertical
            shell={shell}
            pane={sidebar}
            value={layout.sidebarWidth}
            reset={defaultLayout.sidebarWidth}
            enabled={state.ready}
            change={(sidebarWidth) => changeLayout({ sidebarWidth })}
            label="layout.resizeSidebar"
            controls="workspace-sidebar"
          />
        )}
        <section className="editor-column">
          <div className="tabs" role="tablist" aria-label={t("editor.tabs")}>
            {state.tabs.map((tab) => (
              <div
                className={`tab ${tab.uri === state.active ? "active" : ""}`}
                key={tab.uri}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.uri === state.active}
                  onClick={() => {
                    setGitDiff(undefined);
                    workbench.activate(tab.uri);
                  }}
                >
                  <span className="file-icon" aria-hidden="true">
                    #
                  </span>
                  {tab.name}
                </button>
                <button
                  type="button"
                  className={tab.dirty ? "dirty close-tab" : "close-tab"}
                  onClick={() => run(() => workbench.close(tab.uri))}
                  aria-label={t("editor.closeTab", { name: tab.name })}
                  title={tab.dirty ? t("editor.dirty") : t("command.close")}
                >
                  {tab.dirty ? "●" : "×"}
                </button>
              </div>
            ))}
          </div>
          {external && (
            <div className="external-notice" role="status">
              <span>
                {t(
                  external === "changed"
                    ? "editor.externalChanged"
                    : "editor.externalDeleted"
                )}
              </span>
              {external === "changed" && (
                <button
                  type="button"
                  onClick={() => run(() => workbench.reload())}
                >
                  {t("command.reload")}
                </button>
              )}
              <button
                type="button"
                onClick={() => run(() => workbench.save(undefined, true))}
              >
                {t("command.saveAs")}
              </button>
            </div>
          )}
          {activeTitle?.largeFile && (
            <div className="external-notice" role="status">
              {t("editor.largeFile")}
            </div>
          )}
          <div className="editor-area" data-editor-fill="true">
            <div
              className="monaco-container"
              ref={container}
              style={gitDiff ? { visibility: "hidden" } : undefined}
            />
            {gitDiff && (
              <GitDiffView
                diff={gitDiff}
                close={() => {
                  setGitDiff(undefined);
                  workbench.focusEditor();
                }}
              />
            )}
            {!active && !gitDiff && (
              <div className="empty-editor">
                <h1>{t("app.name")}</h1>
                <p>{t("editor.welcome")}</p>
                <p className="muted">
                  {state.ready
                    ? desktop
                      ? t("editor.empty")
                      : t("editor.desktopRequired")
                    : t("editor.loading")}
                </p>
                <div className="welcome-actions">
                  <button
                    type="button"
                    disabled={!command("command.openFile").enabled}
                    onClick={() => run(() => workbench.openFile())}
                  >
                    {t("command.openFile")}
                    <kbd>Ctrl+O</kbd>
                  </button>
                  <button
                    type="button"
                    disabled={!command("command.openFolder").enabled}
                    onClick={() => run(() => workbench.chooseFolder())}
                  >
                    {t("command.openFolder")}
                    <kbd>Ctrl+K Ctrl+O</kbd>
                  </button>
                </div>
                {state.recent.length > 0 && (
                  <>
                    <h2>{t("recent.title")}</h2>
                    <ul className="recent-list">
                      {state.recent.map((path) => (
                        <li key={path}>
                          <button
                            type="button"
                            title={path}
                            disabled={!command("command.openFolder").enabled}
                            onClick={() =>
                              run(() => workbench.chooseFolder(path))
                            }
                          >
                            {path}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {state.recentFiles.length > 0 && (
                  <>
                    <h2>{t("recent.files")}</h2>
                    <ul className="recent-list">
                      {state.recentFiles.map((path) => (
                        <li key={path}>
                          <button
                            type="button"
                            title={path}
                            disabled={!command("command.openFile").enabled}
                            onClick={() =>
                              run(() => workbench.recentFile(path))
                            }
                          >
                            {path}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
          <>
            {layout.panelVisible && (
              <Splitter
                vertical={false}
                shell={shell}
                pane={panel}
                value={layout.panelHeight}
                reset={defaultLayout.panelHeight}
                enabled={state.ready}
                change={(panelHeight) => changeLayout({ panelHeight })}
                label="layout.resizePanel"
                controls="workspace-panel"
              />
            )}
            <div
              ref={panel}
              id="workspace-panel"
              className="bottom-panel"
              hidden={!layout.panelVisible}
            >
              <div className="panel-tabs-heading">
                <div role="tablist" aria-label={t("panel.tabs")}>
                  {(["problems", "build", "terminal"] as const).map(
                    (kind, index, kinds) => (
                      <button
                        key={kind}
                        id={`panel-tab-${kind}`}
                        type="button"
                        role="tab"
                        aria-selected={layout.panel === kind}
                        aria-controls={`panel-${kind}`}
                        tabIndex={layout.panel === kind ? 0 : -1}
                        onClick={() => setPanel(kind, true)}
                        onKeyDown={(event) => {
                          let selected: typeof kind | undefined;
                          if (event.key === "ArrowRight")
                            selected = kinds[(index + 1) % kinds.length];
                          if (event.key === "ArrowLeft")
                            selected =
                              kinds[(index + kinds.length - 1) % kinds.length];
                          if (event.key === "Home") selected = kinds[0];
                          if (event.key === "End") selected = kinds.at(-1);
                          if (selected) {
                            event.preventDefault();
                            setPanel(selected, true);
                            document
                              .getElementById(`panel-tab-${selected}`)
                              ?.focus();
                          }
                        }}
                      >
                        {t(
                          kind === "problems"
                            ? "command.problems"
                            : kind === "build"
                              ? "build.output"
                              : "terminal.title"
                        )}
                        {kind === "problems" && state.problems.length > 0 && (
                          <span className="panel-count">
                            {state.problems.length}
                          </span>
                        )}
                      </button>
                    )
                  )}
                </div>
                <div className="panel-header-actions">
                  <div
                    ref={setTerminalControls}
                    className="terminal-header-controls"
                    hidden={!terminalOpen}
                  />
                  <button
                    type="button"
                    aria-label={t("panel.close")}
                    onClick={() => setPanel(layout.panel, false)}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div
                role="tabpanel"
                id="panel-problems"
                aria-labelledby="panel-tab-problems"
                className="panel-content"
                hidden={!problemsOpen}
              >
                {problemsOpen && (
                  <section className="problems-panel">
                    {state.problems.length ? (
                      <ul>
                        {state.problems.map((problem, index) => (
                          <li key={index}>
                            <button
                              type="button"
                              onClick={() =>
                                run(() =>
                                  workbench.openUri(
                                    problem.resource.toString(),
                                    problem.startLineNumber,
                                    problem.startColumn
                                  )
                                )
                              }
                            >
                              <span
                                className={
                                  problem.severity === 8
                                    ? "problem-error"
                                    : "problem-warning"
                                }
                                aria-hidden="true"
                              >
                                ●
                              </span>
                              <span>{problem.message}</span>
                              <small>
                                {t("problems.location", {
                                  file:
                                    problem.resource.path.split("/").at(-1) ??
                                    "",
                                  line: problem.startLineNumber,
                                  column: problem.startColumn,
                                })}
                              </small>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{t("problems.empty")}</p>
                    )}
                  </section>
                )}
              </div>
              <div
                role="tabpanel"
                id="panel-build"
                aria-labelledby="panel-tab-build"
                className="panel-content"
                hidden={!buildOpen}
              >
                {buildOpen && (
                  <BuildPanel
                    state={state.build}
                    configure={configureProject}
                  />
                )}
              </div>
              <div
                role="tabpanel"
                id="panel-terminal"
                aria-labelledby="panel-tab-terminal"
                className="panel-content"
                hidden={!terminalOpen}
              >
                <TerminalPanel
                  ref={terminal}
                  root={state.root}
                  visible={terminalOpen}
                  controls={terminalControls}
                  settings={state.settings}
                />
              </div>
            </div>
          </>
        </section>
      </div>
      <footer className="statusbar">
        <span role="status" title={state.languageTool?.path}>
          {state.languageProgress || state.status}
        </span>
        {!connected &&
          command("command.restartLanguage").enabled &&
          state.languagePhase !== "starting" && (
            <button
              type="button"
              onClick={() =>
                executeCommand(
                  command("command.restartLanguage"),
                  workbench.report
                )
              }
            >
              {t("command.restartLanguage")}
            </button>
          )}
        <button
          type="button"
          onClick={() => setProblemsOpen((value) => !value)}
        >
          {t("status.problems", { count: state.problems.length })}
        </button>
        <span className="status-spacer" />
        {active && (
          <>
            <span>{t("status.position", state.position)}</span>
            <button
              type="button"
              title={t(
                activeTitle?.encodingGuessed
                  ? "encoding.detected"
                  : "command.encoding"
              )}
              onClick={() => setEncodingTarget(state.active)}
              disabled={!nativeReady || state.mutationBusy}
            >
              {encodingLabel({
                encoding: activeTitle?.encoding ?? "utf-8",
                bom: activeTitle?.bom ?? false,
              })}
            </button>
          </>
        )}
      </footer>
      {state.prompt && (
        <Modal
          label={t("prompt.unsaved", { name: state.prompt.name })}
          onCancel={() => workbench.answerPrompt("cancel")}
        >
          <h2>{t("prompt.unsaved", { name: state.prompt.name })}</h2>
          <p>{t("prompt.unsavedDetail")}</p>
          <footer>
            <button
              type="button"
              className="primary"
              onClick={() => workbench.answerPrompt("save")}
            >
              {t("prompt.save")}
            </button>
            <button
              type="button"
              onClick={() => workbench.answerPrompt("discard")}
            >
              {t("prompt.discard")}
            </button>
            <button
              type="button"
              onClick={() => workbench.answerPrompt("cancel")}
            >
              {t("prompt.cancel")}
            </button>
          </footer>
        </Modal>
      )}
      {(encodingDocument || encodingTarget === "open") && (
        <EncodingDialog
          document={encodingDocument}
          close={() => setEncodingTarget(undefined)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={state.settings}
          tool={state.languageTool}
          close={() => setSettingsOpen(false)}
        />
      )}
      {symbolsOpen && (
        <SymbolsDialog
          mode={symbolsOpen}
          close={() => setSymbolsOpen(undefined)}
        />
      )}
      {projectOpen && (
        <ProjectDialog
          state={state}
          close={() => setProjectOpen(false)}
          build={startBuild}
        />
      )}
      {quickOpen && <QuickOpen close={() => setQuickOpen(false)} />}
      {commandOpen && (
        <CommandPalette
          commands={registeredCommands}
          close={() => setCommandOpen(false)}
        />
      )}
    </main>
  );
}

export default App;
