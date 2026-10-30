import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { Uri } from "monaco-editor";
import { workbench, type SymbolResult } from "./app/workbench";
import { desktop } from "./lib/native";
import { Explorer } from "./explorer/Explorer";
import { t } from "./lib/i18n";
import { Menubar, Menu, MenuItem } from "./components/Menubar";
import { Modal } from "./components/Modal";
import { CommandPalette } from "./components/CommandPalette";
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
import { defaultThemes, themeVariables } from "./settings/theme";
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
                theme: event.target.value === "light" ? "light" : "dark",
              })
            }
          >
            <option value="dark">{t("settings.dark")}</option>
            <option value="light">{t("settings.light")}</option>
          </select>
        </label>
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
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState<
    "document" | "workspace" | undefined
  >();
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchFields, setSearchFields] = useState(initialSearchFields);
  const [treeRevision, setTreeRevision] = useState(0);
  const [explorerReveal, setExplorerReveal] = useState(0);
  const active = Boolean(state.active);
  const external = state.tabs.find((tab) => tab.uri === state.active)?.external;
  const connected = state.languagePhase === "ready";
  const nativeReady = desktop && state.ready;
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
    project: () => setProjectOpen(true),
    explorer: () => {
      setSearchOpen(false);
      setExplorerReveal((value) => value + 1);
    },
    search: () => setSearchOpen(true),
    quickOpen: () => setQuickOpen(true),
    problems: () => setProblemsOpen((value) => !value),
    symbols: setSymbolsOpen,
    build: startBuild,
    buildOutput: () => {
      setBuildOpen(true);
      setProblemsOpen(false);
    },
    palette: () => setCommandOpen(true),
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
      let operation: (() => Promise<unknown>) | undefined;
      const key = event.key.toLowerCase();
      if (event.key === "F1" || (modifier && event.shiftKey && key === "p")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (state.ready) setCommandOpen(true);
        return;
      }
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
        setSearchOpen(false);
        setExplorerReveal((value) => value + 1);
        return;
      } else if (modifier && event.shiftKey && key === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSearchOpen(true);
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
      } else if (modifier && key === "j") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setProblemsOpen((value) => !value);
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
      className="workbench"
      style={
        themeVariables(defaultThemes[state.settings.theme]) as CSSProperties
      }
    >
      <header className="ide-menubar">
        <span className="app-mark" aria-label={t("app.name")}>
          ♟
        </span>
        <Menubar label={t("app.name")}>
          <Menu label="menu.file">
            <CommandMenuItem command={command("command.newFile")} />
            <CommandMenuItem command={command("command.openFile")} />
            <CommandMenuItem command={command("command.openFolder")} />
            <hr />
            <CommandMenuItem command={command("command.save")} />
            <CommandMenuItem command={command("command.saveAs")} />
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
            <CommandMenuItem command={command("search.files")} />
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
        </Menubar>
        <span className="window-title">
          {state.root?.split(/[\\/]/).at(-1) ?? t("app.name")}
        </span>
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
        <aside className="explorer">
          {searchOpen ? (
            <SearchPanel
              root={state.root}
              fields={searchFields}
              change={setSearchFields}
              close={() => setSearchOpen(false)}
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
                refresh={() => setTreeRevision((value) => value + 1)}
              />
            </>
          )}
        </aside>
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
                  onClick={() => workbench.activate(tab.uri)}
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
          <div className="editor-area">
            <div className="monaco-container" ref={container} />
            {!active && (
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
                    disabled={!nativeReady}
                    onClick={() => run(() => workbench.openFile())}
                  >
                    {t("command.openFile")}
                    <kbd>Ctrl+O</kbd>
                  </button>
                  <button
                    type="button"
                    disabled={!nativeReady}
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
          {problemsOpen && (
            <section className="problems-panel">
              <div className="panel-heading">
                <span>
                  {t("command.problems")} ({state.problems.length})
                </span>
                <button
                  type="button"
                  onClick={() => setProblemsOpen(false)}
                  aria-label={t("command.close")}
                >
                  ×
                </button>
              </div>
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
                            file: problem.resource.path.split("/").at(-1) ?? "",
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
          {buildOpen && !problemsOpen && (
            <BuildPanel
              state={state.build}
              close={() => setBuildOpen(false)}
              configure={() => setProjectOpen(true)}
            />
          )}
        </section>
      </div>
      <footer className="statusbar">
        <span title={state.languageTool?.path}>
          {state.languageProgress || state.status}
        </span>
        {!connected && nativeReady && state.languagePhase !== "starting" && (
          <button
            type="button"
            onClick={() => run(() => workbench.restartLanguage())}
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
            <span>UTF-8</span>
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
