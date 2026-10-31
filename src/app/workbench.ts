import { editor, Uri, type IDisposable } from "monaco-editor";
import {
  createModelReference,
  type IReference,
  type ITextFileEditorModel,
} from "@codingame/monaco-vscode-api/monaco";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  native,
  desktop,
  type FileSnapshot,
  type Entry,
  type WatchEvent,
  type ToolInfo,
} from "../lib/native";
import { t, describeError } from "../lib/i18n";
import {
  applyEditorSettings,
  files,
  initializeEditor,
} from "../editor/services";
import { defaults, parseSettings, type Settings } from "../settings/settings";
import { startLanguageSession, type LanguageSession } from "../language/client";
import { BufferVersion } from "./documents";
import { NavigationHistory, type NavigationDirection } from "./navigation";
import { largeFileCharacters, type TextEncoding } from "../editor/text-files";
import {
  changesWorkingTree,
  type GitAction,
  type GitDiff,
  type OpenGitDiff,
} from "../sourceControl/types";
import { protocolUri } from "../lib/uri";
import { languageFeatures, type LanguageFeatures } from "../language/features";
import { RecoveryPolicy } from "../language/recovery";
import { commands } from "vscode";
import {
  CancellationTokenSource,
  type TextEdit,
  type SymbolInformation,
  type WorkspaceSymbol,
  type DocumentSymbol,
} from "vscode-languageclient/browser";
import {
  building,
  type BuildState,
  type ProjectInfo,
  type Discovery,
  type BuildTools,
} from "../build/types";
import { buildConfiguration } from "../build/configuration";
import type {
  SearchOptions,
  SearchResult,
  SearchOverlay,
} from "../search/types";
import {
  pathKey,
  withinPath,
  parentPath,
  childPath,
  fileName,
  reconcilePaths,
} from "../lib/paths";

interface OpenDocument {
  uri: string;
  name: string;
  snapshot?: FileSnapshot;
  model: editor.ITextModel;
  versions: BufferVersion;
  reference?: IReference<ITextFileEditorModel>;
  file?: IDisposable;
  listener: IDisposable;
  view?: editor.ICodeEditorViewState | null;
  external?: "changed" | "deleted";
  largeFile: boolean;
}

export interface Tab {
  uri: string;
  name: string;
  dirty: boolean;
  external?: "changed" | "deleted";
  encoding?: string;
  bom?: boolean;
  encodingGuessed?: boolean;
  largeFile?: boolean;
}

export interface SymbolResult {
  name: string;
  container?: string;
  uri: string;
  line: number;
  column: number;
}
type Choice = "save" | "discard" | "cancel";

export interface WorkbenchState {
  ready: boolean;
  root?: string;
  recent: string[];
  recentFiles: string[];
  tabs: Tab[];
  active?: string;
  settings: Settings;
  status: string;
  error?: string;
  problems: editor.IMarker[];
  prompt?: { name: string };
  position: { line: number; column: number };
  treeVersion: number;
  languagePhase: "stopped" | "starting" | "ready" | "recovering";
  languageFeatures?: LanguageFeatures;
  languageTool?: ToolInfo;
  languageProgress?: string;
  project?: ProjectInfo;
  selectedBuild: string;
  build: BuildState;
  mutationBusy: boolean;
  canReopen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export class Workbench {
  private state: WorkbenchState = {
    ready: false,
    recent: [],
    recentFiles: [],
    tabs: [],
    settings: defaults,
    status: t("status.ready"),
    problems: [],
    position: { line: 1, column: 1 },
    treeVersion: 0,
    languagePhase: "stopped",
    selectedBuild: "",
    build: { phase: "idle" },
    mutationBusy: false,
    canReopen: false,
    canGoBack: false,
    canGoForward: false,
  };

  private subscribers = new Set<() => void>();

  private documents = new Map<string, OpenDocument>();

  private largeDocuments = new Set<string>();

  private opening = new Map<string, Promise<void>>();

  private codeEditor?: editor.IStandaloneCodeEditor;

  private language?: LanguageSession;

  private languageRoot?: string;

  private languageQueue: Promise<void> = Promise.resolve();

  private sessionDocuments = new Set<string>();

  private untitled = 0;

  private closed: string[] = [];

  private navigation = new NavigationHistory();

  private navigationMuted = 0;

  private navigating = false;

  private navigationQueue: Promise<void> = Promise.resolve();

  private answer?: (choice: Choice) => void;

  private closeListener?: () => void;

  private saving = new Map<string, Promise<boolean>>();

  private settingsQueue: Promise<void> = Promise.resolve();

  private languageGeneration = 0;

  private recovery = new RecoveryPolicy();

  private recoveryTimer?: ReturnType<typeof setTimeout>;

  private symbolRequest?: CancellationTokenSource;

  private watchQueue: Promise<void> = Promise.resolve();

  private diskQueue: Promise<void> = Promise.resolve();

  private watchGeneration = 0;

  private watchSignature = "";

  private pendingDisk = new Set<string>();

  private closingWindow = false;

  private projectGeneration = 0;

  private buildPending?: Promise<void>;

  private buildCancelRequested = false;

  private searchId = 0;

  async runGit(
    root: string,
    id: number,
    revision: string,
    action: GitAction
  ): Promise<string> {
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    if (building(this.state.build)) throw { code: "buildBusy" };
    if (this.state.root !== root) throw { code: "gitChanged" };
    const changesFiles = changesWorkingTree(action);
    if (changesFiles && this.state.tabs.some((tab) => tab.dirty))
      throw { code: "gitDirty" };
    this.update({ mutationBusy: true });
    this.codeEditor?.updateOptions({ readOnly: true });
    try {
      if (changesFiles) {
        await this.stopWatching();
        await this.diskQueue;
        await Promise.all(this.saving.values());
        if (this.state.tabs.some((tab) => tab.dirty))
          throw { code: "gitDirty" };
      }
      return await native.git<string>(root, id, {
        kind: "execute",
        revision,
        action,
      });
    } finally {
      try {
        if (changesFiles) {
          for (const document of this.documents.values())
            await this.reconcileDocument(document);
          await this.restartLanguage();
          this.update({ project: undefined, selectedBuild: "" });
        }
      } finally {
        this.codeEditor?.updateOptions({ readOnly: false });
        this.update({
          mutationBusy: false,
          treeVersion: this.state.treeVersion + 1,
        });
        await this.startWatching();
      }
    }
  }

  gitDiff(path: string, staged: boolean, value: GitDiff): OpenGitDiff {
    const fullPath = this.state.root ? childPath(this.state.root, path) : "";
    const document = [...this.documents.values()].find(
      (document) =>
        document.snapshot &&
        pathKey(document.snapshot.path) === pathKey(fullPath)
    );
    const unsaved = !staged && Boolean(document?.versions.dirty);
    return {
      ...value,
      path,
      staged,
      unsaved,
      after:
        unsaved && document && !value.unsupported
          ? document.model.getValue()
          : value.after,
    };
  }

  getSnapshot = (): WorkbenchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  private update(patch: Partial<WorkbenchState> = {}): void {
    this.state = {
      ...this.state,
      ...patch,
      canReopen: this.closed.length > 0,
      canGoBack: this.navigation.canGoBack,
      canGoForward: this.navigation.canGoForward,
      tabs: [...this.documents.values()].map((document) => ({
        uri: document.uri,
        name: document.name,
        dirty: document.versions.dirty,
        external: document.external,
        encoding: document.snapshot?.encoding ?? "utf-8",
        bom: document.snapshot?.bom ?? false,
        encodingGuessed: document.snapshot?.encodingGuessed,
        largeFile: document.largeFile,
      })),
    };
    for (const subscriber of this.subscribers) subscriber();
  }

  report = (error: unknown): void => {
    console.error(error);
    this.update({ error: describeError(error) });
  };

  dismissError = (): void => {
    this.update({ error: undefined });
  };

  async mount(container: HTMLElement): Promise<() => void> {
    let settings = defaults;
    if (desktop) {
      try {
        const preferences = await native.preferences();
        settings = parseSettings(preferences.settings);
        this.update({
          settings,
          recent: preferences.recentWorkspaces,
          recentFiles: preferences.recentFiles,
        });
      } catch (error) {
        this.report(error);
      }
    }
    await initializeEditor(
      settings,
      async (uri, line, column) => {
        await this.openUri(uri, line, column);
      },
      (uris) => this.prepareWorkspaceEdits(uris),
      this.report
    );
    this.codeEditor = editor.create(container, {
      model: null,
      automaticLayout: true,
      ariaLabel: t("app.name"),
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      minimap: { enabled: settings.minimap },
      scrollBeyondLastLine: false,
    });
    const cursor = this.codeEditor.onDidChangeCursorPosition((event) => {
      this.rememberLocation(
        event.reason === editor.CursorChangeReason.Explicit ? "move" : "edit"
      );
      this.update({
        position: {
          line: event.position.lineNumber,
          column: event.position.column,
        },
      });
    });
    const markers = editor.onDidChangeMarkers(() =>
      this.update({
        problems: editor
          .getModelMarkers({})
          .filter((marker) => this.documents.has(marker.resource.toString())),
      })
    );
    if (desktop)
      this.closeListener = await getCurrentWindow().onCloseRequested(
        async (event) => {
          event.preventDefault();
          if (this.state.prompt || this.closingWindow) return;
          if (this.state.mutationBusy) {
            this.report({ code: "fileOperationBusy" });
            return;
          }
          this.closingWindow = true;
          try {
            if (await this.closeAll()) {
              await this.cancelBuild();
              await this.buildPending;
              await this.stopLanguage();
              await this.stopWatching();
              await native.terminalCloseAll();
              await getCurrentWindow().destroy();
            }
          } catch (error) {
            this.report(error);
          } finally {
            this.closingWindow = false;
          }
        }
      );
    this.update({
      ready: true,
      status: desktop ? t("status.ready") : t("editor.desktopRequired"),
    });
    return () => {
      cursor.dispose();
      markers.dispose();
      this.closeListener?.();
      this.codeEditor?.dispose();
      this.codeEditor = undefined;
    };
  }

  async openFile(encoding?: string): Promise<boolean> {
    const snapshot = await native.chooseDocument(encoding);
    if (!snapshot) return false;
    await this.openSnapshot(snapshot);
    return true;
  }

  async recentFile(path: string): Promise<void> {
    await this.openSnapshot(await native.recentDocument(path));
  }

  async openPath(path: string): Promise<void> {
    await this.openSnapshot(await native.read(path));
  }

  async openUri(uri: string, line?: number, column?: number): Promise<void> {
    this.rememberLocation("edit");
    this.navigationMuted++;
    try {
      uri = Uri.parse(uri).toString();
      if (!this.documents.has(uri)) await this.openPath(Uri.parse(uri).fsPath);
      this.activate(uri);
      if (line) {
        this.codeEditor?.setPosition({ lineNumber: line, column: column ?? 1 });
        this.codeEditor?.revealLineInCenter(line);
      }
      this.codeEditor?.focus();
    } finally {
      this.navigationMuted--;
      this.rememberLocation("jump");
      this.update();
    }
  }

  private rememberLocation(kind: "move" | "edit" | "jump"): void {
    if (this.navigationMuted || this.navigating) return;
    const uri = this.codeEditor?.getModel()?.uri.toString();
    const position = this.codeEditor?.getPosition();
    if (uri && position && this.documents.has(uri))
      this.navigation.record(
        { uri, line: position.lineNumber, column: position.column },
        kind
      );
  }

  navigate(direction: NavigationDirection): Promise<void> {
    const pending = this.navigationQueue.then(() =>
      this.restoreLocation(direction)
    );
    this.navigationQueue = pending.catch(() => undefined);
    return pending;
  }

  private async restoreLocation(direction: NavigationDirection): Promise<void> {
    if (this.navigating || this.state.prompt || this.state.mutationBusy) return;
    this.rememberLocation("edit");
    const location = this.navigation.peek(direction);
    if (!location) return;
    this.navigating = true;
    try {
      await this.openUri(location.uri, location.line, location.column);
      this.navigation.move(direction);
    } catch (error) {
      this.navigation.removeWhere((entry) => entry.uri === location.uri);
      throw error;
    } finally {
      this.navigating = false;
      this.update();
    }
  }

  private async openSnapshot(snapshot: FileSnapshot): Promise<void> {
    snapshot = { ...snapshot, uri: Uri.parse(snapshot.uri).toString() };
    if (this.documents.has(snapshot.uri)) {
      this.activate(snapshot.uri);
      return;
    }
    const existing = this.opening.get(snapshot.uri);
    if (existing) return existing;
    // pawnlsp retains query versions after didClose; stop before exposing a new version-1 model
    // to its old providers. A fresh session reopens every remaining buffer without losing edits.
    if (this.language && this.sessionDocuments.has(snapshot.uri))
      await this.stopLanguage();
    const opening = this.addDocument(
      snapshot.uri,
      snapshot.path.split(/[\\/]/).at(-1) ?? snapshot.path,
      snapshot.text,
      snapshot
    );
    this.opening.set(snapshot.uri, opening);
    try {
      await opening;
    } finally {
      this.opening.delete(snapshot.uri);
    }
    try {
      this.update({
        recentFiles: await native.rememberDocument(snapshot.path),
      });
    } catch (error) {
      this.report(error);
    }
    await this.ensureLanguage();
    this.sessionDocuments.add(snapshot.uri);
    await this.startWatching();
    const opened = this.documents.get(snapshot.uri);
    if (opened) await this.reconcileDocument(opened);
  }

  async newFile(): Promise<void> {
    const name = t("editor.untitled", { count: ++this.untitled });
    await this.addDocument(`untitled:${name}.pwn`, name, "");
  }

  private async addDocument(
    uri: string,
    name: string,
    text: string,
    snapshot?: FileSnapshot
  ): Promise<void> {
    const resource = Uri.parse(uri);
    const largeFile =
      Boolean(snapshot?.largeFile) || text.length >= largeFileCharacters;
    if (largeFile) this.largeDocuments.add(uri);
    const file =
      resource.scheme === "file" ? files.register(resource, text) : undefined;
    let reference: IReference<ITextFileEditorModel> | undefined;
    try {
      if (resource.scheme === "file")
        reference = await createModelReference(resource);
    } catch (error) {
      file?.dispose();
      this.largeDocuments.delete(uri);
      throw error;
    }
    const model =
      reference?.object.textEditorModel ??
      editor.createModel(text, "pawn", resource);
    editor.setModelLanguage(
      model,
      !largeFile && /\.(pwn|inc)$/i.test(snapshot?.path ?? uri)
        ? "pawn"
        : "plaintext"
    );
    const versions = new BufferVersion(model.getAlternativeVersionId());
    const listener = model.onDidChangeContent(() => {
      versions.changed(model.getAlternativeVersionId());
      const document = this.documents.get(uri);
      if (
        document &&
        !document.largeFile &&
        model.getValueLength() >= largeFileCharacters
      ) {
        document.largeFile = true;
        this.largeDocuments.add(uri);
        editor.setModelLanguage(model, "plaintext");
        if (this.state.active === uri) this.applyFileOptions(document);
      }
      this.update();
    });
    this.documents.set(uri, {
      uri,
      name,
      snapshot,
      model,
      versions,
      reference,
      file,
      listener,
      largeFile,
    });
    this.activate(uri);
  }

  activate(uri: string): void {
    const document = this.documents.get(uri);
    if (!document || !this.codeEditor) return;
    this.rememberLocation("edit");
    const changed = this.state.active !== uri;
    const previous = this.state.active
      ? this.documents.get(this.state.active)
      : undefined;
    if (previous) previous.view = this.codeEditor.saveViewState();
    this.navigationMuted++;
    try {
      this.codeEditor.setModel(document.model);
      this.applyFileOptions(document);
      if (document.view) this.codeEditor.restoreViewState(document.view);
    } finally {
      this.navigationMuted--;
    }
    this.codeEditor.focus();
    this.rememberLocation(changed ? "jump" : "edit");
    const position = this.codeEditor.getPosition();
    this.update({
      active: uri,
      position: {
        line: position?.lineNumber ?? 1,
        column: position?.column ?? 1,
      },
    });
  }

  private applyFileOptions(document?: OpenDocument): void {
    const large = document?.largeFile ?? false;
    this.codeEditor?.updateOptions({
      wordWrap: !large && this.state.settings.wordWrap ? "on" : "off",
      minimap: { enabled: !large && this.state.settings.minimap },
      folding: !large,
      matchBrackets: large ? "never" : "always",
      bracketPairColorization: { enabled: !large },
      renderValidationDecorations: large ? "off" : "on",
      stickyScroll: { enabled: !large },
    });
  }

  focusEditor(): void {
    this.codeEditor?.focus();
  }

  async chooseFolder(recent?: string): Promise<void> {
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    if (building(this.state.build)) throw { code: "buildBusy" };
    const selected = recent ?? (await native.chooseWorkspace());
    if (!selected || !(await this.closeAll())) return;
    await this.cancelSearch();
    await this.stopLanguage();
    const root = recent
      ? await native.recentWorkspace(selected)
      : await native.activateWorkspace(selected);
    const preferences = await native.preferences();
    ++this.projectGeneration;
    this.navigation.clear();
    this.update({
      root,
      recent: preferences.recentWorkspaces,
      project: undefined,
      selectedBuild: "",
      build: { phase: "idle" },
    });
    this.watchSignature = "";
    await this.startWatching();
    await this.ensureLanguage();
  }

  entries = (path: string): Promise<Entry[]> => native.entries(path);

  save(
    uri = this.state.active,
    saveAs = false,
    encoding?: TextEncoding
  ): Promise<boolean> {
    if (!uri) return Promise.resolve(true);
    const saving = this.saving.get(uri);
    if (saving) return saving;
    const pending = this.saveDocument(uri, saveAs, encoding);
    this.saving.set(uri, pending);
    void pending
      .finally(() => {
        this.saving.delete(uri);
        for (const changed of this.pendingDisk) {
          this.pendingDisk.delete(changed);
          const document = this.documents.get(changed);
          if (document)
            void this.reconcileDocument(document).catch(this.report);
        }
      })
      .catch(() => undefined);
    return pending;
  }

  private async saveDocument(
    uri: string,
    saveAs: boolean,
    encoding?: TextEncoding
  ): Promise<boolean> {
    const document = this.documents.get(uri);
    if (!document) return true;
    if (
      this.state.settings.formatOnSave &&
      !document.largeFile &&
      this.state.languageFeatures?.formatting
    )
      await this.format(uri);
    const text = document.model.getValue();
    const version = document.model.getAlternativeVersionId();
    const targetEncoding =
      encoding?.encoding ?? document.snapshot?.encoding ?? "utf-8";
    const targetBom = encoding?.bom ?? document.snapshot?.bom ?? false;
    const result =
      !document.snapshot || saveAs
        ? await native.saveAs(
            text,
            targetBom,
            [...this.documents.values()]
              .filter((other) => other !== document && other.snapshot)
              .map((other) => other.snapshot!.path),
            targetEncoding
          )
        : await native.save(
            document.snapshot.path,
            text,
            targetBom,
            document.snapshot.revision,
            targetEncoding
          );
    if (!result) return false;
    const snapshot = { ...result, uri: Uri.parse(result.uri).toString() };
    if (snapshot.uri !== uri) {
      // Preserve edits made while the native Save dialog or disk write was in flight.
      const current = document.model.getValue();
      const removed = await this.removeDocument(uri);
      await this.openSnapshot(snapshot);
      this.navigation.replaceUri(uri, snapshot.uri);
      const renamed = this.documents.get(snapshot.uri);
      if (removed && renamed && current !== text)
        renamed.model.setValue(current);
    } else {
      document.snapshot = snapshot;
      document.external = undefined;
      files.update(document.model.uri, text);
      if (document.model.getAlternativeVersionId() === version)
        await document.reference?.object.revert({ soft: true });
      document.versions.savedAt(version);
      if (
        document.model.getLanguageId() === "pawn" &&
        this.language?.client.isRunning()
      )
        await this.language.client.sendNotification("textDocument/didSave", {
          textDocument: { uri: protocolUri(document.model.uri) },
          text,
        });
      this.update();
    }
    return true;
  }

  async saveAll(): Promise<boolean> {
    for (const document of [...this.documents.values()])
      if (document.versions.dirty || !document.snapshot) {
        if (!(await this.save(document.uri))) return false;
      }
    return ![...this.documents.values()].some(
      (document) => document.versions.dirty
    );
  }

  discoverProjects = (): Promise<Discovery> => native.discoverProjects();

  buildTools = (): Promise<BuildTools> => native.buildTools();

  async selectProject(path: string): Promise<void> {
    if (building(this.state.build)) throw { code: "buildBusy" };
    const generation = ++this.projectGeneration;
    const project = await native.inspectProject(path);
    if (generation === this.projectGeneration)
      this.update({ project, selectedBuild: "" });
  }

  selectBuild(selectedBuild: string): void {
    if (!building(this.state.build)) this.update({ selectedBuild });
  }

  async configureBuildTool(bundled = false): Promise<void> {
    if (building(this.state.build)) throw { code: "buildBusy" };
    const path = bundled ? "" : await native.chooseBuildTool();
    if (path === null) return;
    await this.settings({ compilerPath: path });
  }

  previewProject = (
    entry: string,
    profile: string,
    includes: string[]
  ): Promise<string> => native.previewProject(entry, profile, includes);

  async createProject(text: string): Promise<void> {
    await native.createProject(text);
    if (this.state.root) await this.selectProject(this.state.root);
    this.update({ treeVersion: this.state.treeVersion + 1 });
    await this.restartLanguage();
  }

  async buildProject(): Promise<void> {
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    if (this.buildPending) return this.buildPending;
    if (!this.state.project) throw { code: "projectRequired" };
    this.buildCancelRequested = false;
    this.buildPending = this.performBuild();
    try {
      await this.buildPending;
    } finally {
      this.buildPending = undefined;
    }
  }

  private async performBuild(): Promise<void> {
    const project = this.state.project!;
    const selectedBuild = this.state.selectedBuild;
    const configuration = buildConfiguration(project, selectedBuild);
    const started = Date.now();
    this.update({
      build: {
        phase: "saving",
        entry: configuration.entry,
        output: configuration.output,
        started,
      },
    });
    try {
      if (!(await this.saveAll()) || this.buildCancelRequested) {
        this.update({ build: { ...this.state.build, phase: "cancelled" } });
        return;
      }
      const result = await native.buildProject(
        {
          root: project.project.root,
          entry: configuration.entry,
          revision: project.manifest.revision,
          build: selectedBuild,
          profile: project.project.profile,
        },
        (event) => {
          this.update({
            build: { ...this.state.build, id: event.id, phase: event.stage },
          });
          if (this.buildCancelRequested)
            void native.cancelBuild(event.id).catch(this.report);
        }
      );
      const phase =
        result.outcome === "cancelled" || result.report?.status === "cancelled"
          ? "cancelled"
          : result.outcome === "completed" && result.report?.status === "passed"
            ? "passed"
            : "failed";
      this.update({
        build: {
          ...this.state.build,
          phase,
          result,
          elapsed: Date.now() - started,
        },
        treeVersion: this.state.treeVersion + 1,
      });
    } catch (error) {
      this.update({
        build: {
          ...this.state.build,
          phase: "failed",
          error: describeError(error),
          elapsed: Date.now() - started,
        },
      });
      throw error;
    }
  }

  async cancelBuild(): Promise<void> {
    this.buildCancelRequested = true;
    if (this.state.build.id) await native.cancelBuild(this.state.build.id);
  }

  async createEntry(
    parent: string,
    name: string,
    directory: boolean
  ): Promise<string> {
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    this.update({ mutationBusy: true });
    try {
      const path = await native.createEntry(parent, name, directory);
      this.update({ treeVersion: this.state.treeVersion + 1 });
      if (!directory) await this.openPath(path);
      return path;
    } finally {
      this.update({ mutationBusy: false });
    }
  }

  private affectedDocuments(path: string): OpenDocument[] {
    return [...this.documents.values()].filter(
      (document) =>
        document.snapshot && withinPath(document.snapshot.path, path)
    );
  }

  async changeEntry(path: string, name?: string): Promise<boolean> {
    if (name === fileName(path)) return true;
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    if (building(this.state.build)) throw { code: "buildBusy" };
    this.update({ mutationBusy: true });
    const active = this.state.active;
    let nextActive = active;
    let changed = false;
    try {
      await this.stopWatching();
      await this.diskQueue;
      await Promise.all(this.saving.values());
      await this.stopLanguage();
      const affected = this.affectedDocuments(path);
      if (name !== undefined) {
        const target = childPath(parentPath(path), name);
        if (
          [...this.documents.values()].some(
            (document) =>
              !affected.includes(document) &&
              document.snapshot &&
              withinPath(document.snapshot.path, target)
          )
        )
          throw { code: "alreadyOpen" };
      }
      const confirmed: {
        document: OpenDocument;
        version: number;
        view?: editor.ICodeEditorViewState | null;
      }[] = [];
      for (const document of affected) {
        const current = await this.confirmClose(document);
        if (!current) return false;
        if (current.snapshot && withinPath(current.snapshot.path, path))
          confirmed.push({
            document: current,
            version: current.model.getAlternativeVersionId(),
            view:
              current.uri === active
                ? this.codeEditor?.saveViewState()
                : current.view,
          });
      }
      if (
        this.affectedDocuments(path).length !== confirmed.length ||
        confirmed.some(
          ({ document, version }) =>
            document.model.getAlternativeVersionId() !== version
        )
      )
        throw { code: "fileOperationChanged" };
      const mutation =
        name === undefined
          ? await native.trashEntry(path)
          : await native.renameEntry(path, name);
      const newPath = mutation.path ?? undefined;
      changed = true;
      this.closed = reconcilePaths(this.closed, mutation.source, newPath);
      this.update({
        recentFiles:
          mutation.recentFiles ??
          reconcilePaths(this.state.recentFiles, mutation.source, newPath),
      });
      if (mutation.warning) this.report(mutation.warning);
      let retained = false;
      for (const { document, version, view } of confirmed) {
        if (document.model.getAlternativeVersionId() !== version) {
          document.external = "deleted";
          retained = true;
          continue;
        }
        const target =
          newPath && document.snapshot
            ? newPath.replaceAll("\\", "/") +
              document.snapshot.path
                .replaceAll("\\", "/")
                .slice(path.replaceAll("\\", "/").length)
            : undefined;
        const snapshot = target ? await native.read(target) : undefined;
        if (
          document.model.getAlternativeVersionId() !== version ||
          !(await this.removeDocument(document.uri))
        ) {
          document.external = "deleted";
          retained = true;
          continue;
        }
        if (snapshot) {
          const uri = Uri.parse(snapshot.uri).toString();
          await this.addDocument(uri, fileName(snapshot.path), snapshot.text, {
            ...snapshot,
            uri,
          });
          const renamed = this.documents.get(uri)!;
          renamed.view = view;
          if (view) this.codeEditor?.restoreViewState(view);
          if (document.uri === active) nextActive = uri;
          try {
            this.update({
              recentFiles: await native.rememberDocument(snapshot.path),
            });
          } catch (error) {
            this.report(error);
          }
        }
      }
      this.navigation.removeWhere((location) => {
        const resource = Uri.parse(location.uri);
        return (
          resource.scheme === "file" &&
          withinPath(resource.fsPath, mutation.source)
        );
      });
      if (nextActive && this.documents.has(nextActive))
        this.activate(nextActive);
      if (retained) this.report({ code: "fileOperationRetained" });
      return true;
    } catch (error) {
      if (changed) {
        for (const document of this.affectedDocuments(path))
          document.external = "deleted";
        this.update();
      }
      throw error;
    } finally {
      const project = this.state.project;
      const invalidate =
        changed &&
        project &&
        (withinPath(project.project.root, path) ||
          withinPath(project.manifest.path, path) ||
          withinPath(
            buildConfiguration(project, this.state.selectedBuild).entry,
            path
          ));
      this.update({
        mutationBusy: false,
        treeVersion: this.state.treeVersion + 1,
        ...(invalidate ? { project: undefined, selectedBuild: "" } : {}),
      });
      try {
        await this.startWatching();
        await this.ensureLanguage();
      } catch (error) {
        this.report(error);
      }
    }
  }

  async search(
    options: SearchOptions,
    replacement?: string
  ): Promise<SearchResult> {
    const root = this.state.root;
    if (!root) throw { code: "noWorkspace" };
    const prefix = this.pathKey(root).replace(/\/+$/, "") + "/";
    const overlays: SearchOverlay[] = [];
    let bytes = 0;
    for (const document of this.documents.values()) {
      if (
        !options.filesOnly &&
        document.snapshot &&
        document.versions.dirty &&
        document.external !== "deleted" &&
        this.pathKey(document.snapshot.path).startsWith(prefix)
      ) {
        if (document.largeFile) {
          overlays.push({
            path: document.snapshot.path,
            text: "",
            version: document.model.getVersionId(),
            excluded: true,
          });
          continue;
        }
        const text = document.model.getValue();
        bytes += text.length * 2;
        if (bytes > 16 * 1024 * 1024) throw { code: "searchBuffersLarge" };
        overlays.push({
          path: document.snapshot.path,
          text,
          version: document.model.getVersionId(),
        });
      }
    }
    return native.search(++this.searchId, options, overlays, replacement);
  }

  async cancelSearch(): Promise<void> {
    if (this.searchId) await native.cancelSearch(this.searchId);
  }

  async applyReplacements(result: SearchResult, root: string): Promise<void> {
    if (
      root !== this.state.root ||
      result.truncated ||
      result.cancelled ||
      result.files.some(
        (file) =>
          typeof file.before !== "string" || typeof file.after !== "string"
      )
    )
      throw { code: "searchChanged" };
    await this.prepareWorkspaceEdits(result.files.map((file) => file.uri));
    const revisions = await Promise.all(
      result.files.map((file) =>
        native.read(file.path).then((snapshot) => snapshot.revision)
      )
    );
    if (result.files.some((file, index) => file.revision !== revisions[index]))
      throw { code: "searchChanged" };
    const documents = result.files.map((file) => {
      const document = this.documents.get(Uri.parse(file.uri).toString());
      if (
        !document ||
        document.model.isDisposed() ||
        document.model.getValue() !== file.before ||
        (file.bufferVersion !== null &&
          document.model.getVersionId() !== file.bufferVersion)
      )
        throw { code: "searchChanged" };
      return { document, file };
    });
    if (root !== this.state.root) throw { code: "searchChanged" };
    for (const { document, file } of documents) {
      document.model.pushStackElement();
      document.model.pushEditOperations(
        [],
        [{ range: document.model.getFullModelRange(), text: file.after! }],
        () => null
      );
      document.model.pushStackElement();
    }
    this.update();
  }

  private async confirmClose(
    document: OpenDocument
  ): Promise<OpenDocument | undefined> {
    let current = document;
    while (current.versions.dirty) {
      const choice = await new Promise<Choice>((resolve) => {
        this.answer = resolve;
        this.update({ prompt: { name: current.name } });
      });
      if (choice === "cancel") return undefined;
      if (choice === "discard") return current;
      if (!(await this.save(current.uri))) return undefined;
      current =
        this.documents.get(current.uri) ??
        this.documents.get(this.state.active ?? "") ??
        current;
    }
    return current;
  }

  answerPrompt(choice: Choice): void {
    const answer = this.answer;
    this.answer = undefined;
    this.update({ prompt: undefined });
    answer?.(choice);
  }

  async close(uri: string): Promise<boolean> {
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    const document = this.documents.get(uri);
    if (!document) return false;
    const confirmed = await this.confirmClose(document);
    if (!confirmed) return false;
    if (confirmed.snapshot) {
      this.closed.push(confirmed.snapshot.path);
      this.closed = this.closed.slice(-20);
    }
    if (!(await this.removeDocument(confirmed.uri)))
      return this.close(confirmed.uri);
    return true;
  }

  private async removeDocument(uri: string): Promise<boolean> {
    const document = this.documents.get(uri);
    if (!document) return true;
    this.rememberLocation("edit");
    const version = document.model.getAlternativeVersionId();
    await document.reference?.object.revert({ soft: true });
    if (document.model.getAlternativeVersionId() !== version) return false;
    if (this.state.active === uri) this.codeEditor?.setModel(null);
    this.documents.delete(uri);
    if (Uri.parse(uri).scheme !== "file")
      this.navigation.removeWhere((location) => location.uri === uri);
    this.largeDocuments.delete(uri);
    document.listener.dispose();
    if (document.reference) document.reference.dispose();
    else document.model.dispose();
    document.file?.dispose();
    const next = [...this.documents.keys()].at(-1);
    if (this.state.active === uri && next) this.activate(next);
    else
      this.update({
        active: this.state.active === uri ? undefined : this.state.active,
      });
    void this.startWatching().catch(this.report);
    return true;
  }

  async closeAll(): Promise<boolean> {
    if (this.state.mutationBusy) throw { code: "fileOperationBusy" };
    const confirmed: { document: OpenDocument; version: number }[] = [];
    for (const document of [...this.documents.values()]) {
      const current = await this.confirmClose(document);
      if (!current) return false;
      confirmed.push({
        document: current,
        version: current.model.getAlternativeVersionId(),
      });
    }
    if (
      this.documents.size !== confirmed.length ||
      confirmed.some(
        ({ document, version }) =>
          document.model.getAlternativeVersionId() !== version
      )
    )
      return false;
    // Stop providers before disposing all models; otherwise their async close/diagnostic
    // callbacks can race shutdown and try to restart the retired client.
    await this.stopLanguage();
    if (
      confirmed.some(
        ({ document, version }) =>
          document.model.getAlternativeVersionId() !== version
      )
    ) {
      await this.ensureLanguage();
      return false;
    }
    for (const { document } of confirmed)
      if (!(await this.removeDocument(document.uri))) return false;
    return true;
  }

  async reopen(): Promise<void> {
    const path = this.closed.pop();
    if (path) await this.openPath(path);
  }

  async reload(encoding?: string): Promise<boolean> {
    const document = this.state.active
      ? this.documents.get(this.state.active)
      : undefined;
    if (!document?.snapshot || !(await this.confirmClose(document)))
      return false;
    const version = document.model.getAlternativeVersionId();
    const snapshot = await native.read(
      document.snapshot.path,
      encoding ?? document.snapshot.encoding
    );
    if (
      this.documents.get(document.uri) !== document ||
      document.model.getAlternativeVersionId() !== version
    ) {
      this.report({ code: "conflict" });
      return false;
    }
    document.model.setValue(snapshot.text);
    document.snapshot = snapshot;
    this.refreshFileMode(document);
    const reloadedVersion = document.model.getAlternativeVersionId();
    document.external = undefined;
    files.update(document.model.uri, snapshot.text);
    await document.reference?.object.revert({ soft: true });
    document.versions.savedAt(reloadedVersion);
    this.update();
    return true;
  }

  private refreshFileMode(document: OpenDocument): void {
    document.largeFile =
      document.snapshot?.largeFile === true ||
      document.model.getValueLength() >= largeFileCharacters;
    if (document.largeFile) this.largeDocuments.add(document.uri);
    else this.largeDocuments.delete(document.uri);
    editor.setModelLanguage(
      document.model,
      !document.largeFile && /\.(pwn|inc)$/i.test(document.name)
        ? "pawn"
        : "plaintext"
    );
    if (document.uri === this.state.active) this.applyFileOptions(document);
  }

  async action(id: string): Promise<void> {
    this.codeEditor?.focus();
    if (id === "editor.action.formatDocument") {
      if (this.state.active) await this.format(this.state.active);
    } else if (id === "undo" || id === "redo")
      this.codeEditor?.trigger("menu", id, null);
    else {
      const action = this.codeEditor?.getAction(id);
      if (action) await action.run();
      else await commands.executeCommand(id);
    }
    this.codeEditor?.focus();
  }

  private async prepareWorkspaceEdits(uris: string[]): Promise<void> {
    this.navigationMuted++;
    const original = this.state.active;
    const versions = new Map(
      [...this.documents.values()].map((document) => [
        document.uri,
        document.model.getVersionId(),
      ])
    );
    try {
      for (const uri of uris) {
        if (!this.documents.has(Uri.parse(uri).toString()))
          await this.openUri(uri);
      }
      for (const [uri, version] of versions)
        if (this.documents.get(uri)?.model.getVersionId() !== version)
          throw { code: "conflict" };
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      if (original) this.activate(original);
      this.navigationMuted--;
    }
  }

  async format(uri: string): Promise<void> {
    const document = this.documents.get(uri);
    const client = this.language?.client;
    if (
      !document?.snapshot ||
      document.largeFile ||
      !client?.isRunning() ||
      !this.state.languageFeatures?.formatting
    )
      return;
    const version = document.model.getVersionId();
    const edits = await client.sendRequest<TextEdit[] | null>(
      "textDocument/formatting",
      {
        textDocument: { uri: protocolUri(document.model.uri) },
        options: {
          tabSize: this.state.settings.tabSize,
          insertSpaces: this.state.settings.insertSpaces,
        },
      }
    );
    if (
      document.model.isDisposed() ||
      version !== document.model.getVersionId()
    )
      throw { code: "conflict" };
    if (!edits?.length) return;
    const changes = edits.map((edit) => {
      const range = {
        startLineNumber: edit.range.start.line + 1,
        startColumn: edit.range.start.character + 1,
        endLineNumber: edit.range.end.line + 1,
        endColumn: edit.range.end.character + 1,
      };
      const valid = document.model.validateRange(range);
      if (
        valid.startLineNumber !== range.startLineNumber ||
        valid.startColumn !== range.startColumn ||
        valid.endLineNumber !== range.endLineNumber ||
        valid.endColumn !== range.endColumn
      )
        throw { code: "invalidLanguageEdit" };
      return { range, text: edit.newText };
    });
    document.model.pushStackElement();
    document.model.pushEditOperations([], changes, () => null);
    document.model.pushStackElement();
  }

  cancelSymbols(): void {
    this.symbolRequest?.cancel();
    this.symbolRequest?.dispose();
    this.symbolRequest = undefined;
  }

  async documentSymbols(query: string): Promise<SymbolResult[]> {
    this.cancelSymbols();
    const session = this.language;
    const document = this.state.active
      ? this.documents.get(this.state.active)
      : undefined;
    if (
      !document?.snapshot ||
      !session?.client.isRunning() ||
      !this.state.languageFeatures?.symbols
    )
      return [];
    const cancellation = new CancellationTokenSource();
    this.symbolRequest = cancellation;
    try {
      const symbols = await session.client.sendRequest<
        (DocumentSymbol | SymbolInformation)[] | null
      >(
        "textDocument/documentSymbol",
        { textDocument: { uri: protocolUri(document.model.uri) } },
        cancellation.token
      );
      if (
        cancellation.token.isCancellationRequested ||
        session !== this.language
      )
        return [];
      const results: SymbolResult[] = [];
      const pending: {
        symbol: DocumentSymbol | SymbolInformation;
        container?: string;
      }[] = (symbols ?? []).map((symbol) => ({ symbol })).reverse();
      while (pending.length) {
        const { symbol, container } = pending.pop()!;
        const location =
          "location" in symbol
            ? symbol.location
            : { uri: document.uri, range: symbol.selectionRange };
        if (
          symbol.name.toLowerCase().includes(query.toLowerCase()) &&
          results.length < 500
        )
          results.push({
            name: symbol.name,
            container,
            uri: location.uri,
            line: location.range.start.line + 1,
            column: location.range.start.character + 1,
          });
        if ("children" in symbol)
          for (const child of [...(symbol.children ?? [])].reverse())
            pending.push({ symbol: child, container: symbol.name });
      }
      return results;
    } catch (error) {
      if (cancellation.token.isCancellationRequested) return [];
      throw error;
    }
  }

  async workspaceSymbols(query: string): Promise<SymbolResult[]> {
    this.cancelSymbols();
    const session = this.language;
    if (
      !session?.client.isRunning() ||
      !this.state.languageFeatures?.workspaceSymbols
    )
      return [];
    const cancellation = new CancellationTokenSource();
    this.symbolRequest = cancellation;
    try {
      const symbols = await session.client.sendRequest<
        (SymbolInformation | WorkspaceSymbol)[] | null
      >("workspace/symbol", { query }, cancellation.token);
      if (
        cancellation.token.isCancellationRequested ||
        session !== this.language
      )
        return [];
      return (symbols ?? []).slice(0, 500).map((symbol) => ({
        name: symbol.name,
        container: symbol.containerName,
        uri: symbol.location.uri,
        line:
          ("range" in symbol.location ? symbol.location.range.start.line : 0) +
          1,
        column:
          ("range" in symbol.location
            ? symbol.location.range.start.character
            : 0) + 1,
      }));
    } catch (error) {
      if (cancellation.token.isCancellationRequested) return [];
      throw error;
    }
  }

  settings(patch: Partial<Settings>): Promise<void> {
    const settings = { ...this.state.settings, ...patch };
    this.update({ settings });
    this.codeEditor?.updateOptions({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      wordWrap: settings.wordWrap ? "on" : "off",
      minimap: { enabled: settings.minimap },
    });
    for (const document of this.documents.values())
      document.model.updateOptions({
        tabSize: settings.tabSize,
        insertSpaces: settings.insertSpaces,
      });
    this.settingsQueue = this.settingsQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.state.settings !== settings) return;
        await applyEditorSettings(settings);
        this.applyFileOptions(
          this.state.active ? this.documents.get(this.state.active) : undefined
        );
        if (desktop) await native.storeSettings(settings);
      });
    return this.settingsQueue;
  }

  private ensureLanguage(): Promise<void> {
    this.languageQueue = this.languageQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.largeDocuments.has(this.state.active ?? "") && !this.language)
          return;
        const document = this.state.active
          ? this.documents.get(this.state.active)?.snapshot
          : undefined;
        const root =
          this.state.root ??
          (document
            ? document.path.slice(
                0,
                document.path.lastIndexOf(
                  document.path.includes("\\") ? "\\" : "/"
                )
              )
            : undefined);
        if (!desktop || !root || this.languageRoot === root) return;
        await this.stopLanguage();
        const generation = this.languageGeneration;
        this.update({
          status: t("status.starting"),
          languagePhase: "starting",
          error: undefined,
        });
        try {
          const session = await startLanguageSession(
            root,
            document?.path,
            () => this.languageClosed(generation),
            (message) => {
              if (generation === this.languageGeneration)
                this.update({ languageProgress: message });
            },
            (uri) => !this.largeDocuments.has(Uri.parse(uri).toString())
          );
          if (generation !== this.languageGeneration || this.closingWindow) {
            await session.stop();
            return;
          }
          this.language = session;
          this.sessionDocuments = new Set([...this.documents.keys()]);
          this.languageRoot = root;
          this.update({
            status: t("status.connected"),
            languagePhase: "ready",
            languageTool: session.tool,
            languageFeatures: languageFeatures(
              session.client.initializeResult?.capabilities ?? {}
            ),
          });
        } catch (error) {
          if (generation === this.languageGeneration) {
            this.update({
              status: t("status.stopped"),
              languagePhase: "stopped",
              languageFeatures: undefined,
            });
            this.report(error);
          }
        }
      });
    return this.languageQueue;
  }

  private async stopLanguage(): Promise<void> {
    ++this.languageGeneration;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.cancelSymbols();
    const session = this.language;
    this.language = undefined;
    this.languageRoot = undefined;
    this.update({
      status: t("status.ready"),
      languagePhase: "stopped",
      languageFeatures: undefined,
      languageProgress: undefined,
    });
    await session?.stop();
  }

  private languageClosed(generation: number): void {
    if (generation !== this.languageGeneration || this.closingWindow) return;
    this.languageRoot = undefined;
    const delay = this.recovery.next();
    this.update({
      status: t(delay === undefined ? "status.crashLoop" : "status.recovering"),
      languagePhase: delay === undefined ? "stopped" : "recovering",
      languageFeatures: undefined,
      languageProgress: undefined,
    });
    if (delay !== undefined)
      this.recoveryTimer = setTimeout(() => {
        if (generation === this.languageGeneration)
          void this.ensureLanguage().catch(this.report);
      }, delay);
  }

  async restartLanguage(): Promise<void> {
    this.recovery.reset();
    await this.stopLanguage();
    await this.ensureLanguage();
  }

  async configureLanguageServer(bundled = false): Promise<void> {
    const path = bundled ? "" : await native.chooseLanguageServer();
    if (path === null) return;
    await this.settings({ languageServerPath: path });
    await this.restartLanguage();
  }

  async quit(): Promise<void> {
    await getCurrentWindow().close();
  }

  private pathKey(path: string): string {
    return pathKey(path);
  }

  private startWatching(): Promise<void> {
    if (this.state.mutationBusy) return Promise.resolve();
    this.watchQueue = this.watchQueue
      .catch(() => undefined)
      .then(async () => {
        if (!desktop) return;
        const paths = [...this.documents.values()].flatMap((document) =>
          document.snapshot ? [document.snapshot.path] : []
        );
        const root = this.state.root
          ? this.pathKey(this.state.root)
          : undefined;
        const external = paths
          .filter((path) => !root || !this.pathKey(path).startsWith(`${root}/`))
          .sort();
        const signature = JSON.stringify([root, external]);
        if (signature === this.watchSignature) return;
        const generation = ++this.watchGeneration;
        await native.watch(paths, (event) => {
          if (generation === this.watchGeneration)
            this.onDiskEvent(event, generation);
        });
        this.watchSignature = signature;
      });
    return this.watchQueue;
  }

  private async stopWatching(): Promise<void> {
    ++this.watchGeneration;
    await this.watchQueue.catch(() => undefined);
    await native.stopWatch();
    this.watchSignature = "";
  }

  private onDiskEvent(event: WatchEvent, generation: number): void {
    this.update({ treeVersion: this.state.treeVersion + 1 });
    if (event.error) this.report({ code: "watchFailed", detail: event.error });
    this.diskQueue = this.diskQueue
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.watchGeneration) return;
        const changed = new Set(event.paths.map((path) => this.pathKey(path)));
        let reindex = event.rescan;
        for (const document of this.documents.values()) {
          if (
            document.snapshot &&
            (event.rescan || changed.has(this.pathKey(document.snapshot.path)))
          ) {
            const missing = document.external === "deleted";
            await this.reconcileDocument(document);
            reindex ||= missing !== (document.external === "deleted");
          }
        }
        const relevant = event.paths.filter(
          (path) =>
            /\.(pwn|inc)$/i.test(path) ||
            /(?:^|[\\/])(pawn\.(json|ya?ml)|pawnlint\.toml)$/i.test(path)
        );
        // pawnlsp 0.33.75 can retain an empty project graph after a missing entry returns.
        // Restart only on presence transitions/rescan, reopening every unsaved buffer.
        if (reindex && this.language) await this.restartLanguage();
        // A restarted server still needs the filesystem event after its initial
        // document opens have settled, otherwise it can keep the missing graph.
        if (relevant.length && this.language?.client.isRunning()) {
          await this.language.client.sendNotification(
            "workspace/didChangeWatchedFiles",
            {
              changes: relevant.map((path) => ({
                uri: protocolUri(Uri.file(path)),
                type: 2,
              })),
            }
          );
        }
      })
      .catch(this.report);
  }

  private async reconcileDocument(document: OpenDocument): Promise<void> {
    if (!document.snapshot || this.documents.get(document.uri) !== document)
      return;
    if (this.saving.has(document.uri)) {
      this.pendingDisk.add(document.uri);
      return;
    }
    const version = document.model.getAlternativeVersionId();
    try {
      if (
        (await native.revision(document.snapshot.path)) ===
        document.snapshot.revision
      ) {
        if (document.external) {
          document.external = undefined;
          this.update();
        }
        return;
      }
      const snapshot = await native.read(
        document.snapshot.path,
        document.snapshot.encoding
      );
      if (this.documents.get(document.uri) !== document) return;
      if (snapshot.revision === document.snapshot.revision) {
        if (document.external) {
          document.external = undefined;
          this.update();
        }
        return;
      }
      if (
        !document.versions.dirty &&
        document.model.getAlternativeVersionId() === version
      ) {
        if (document.model.getValue() !== snapshot.text)
          document.model.setValue(snapshot.text);
        const reloadedVersion = document.model.getAlternativeVersionId();
        document.snapshot = { ...snapshot, uri: document.uri };
        this.refreshFileMode(document);
        files.update(document.model.uri, snapshot.text);
        await document.reference?.object.revert({ soft: true });
        document.versions.savedAt(reloadedVersion);
        document.external = undefined;
      } else document.external = "changed";
      this.update();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "notFound"
      ) {
        document.external = "deleted";
        this.update();
      } else this.report(error);
    }
  }
}

export const workbench = new Workbench();
