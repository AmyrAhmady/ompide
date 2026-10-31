// Based on TypeFox's extended EditorService example (11.0.3); no VS Code workbench UI.
import { LogLevel } from "@codingame/monaco-vscode-api";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import { updateUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override";
import { registerFileSystemOverlay } from "@codingame/monaco-vscode-files-service-override";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import { configureWorkers } from "./workers";
import type { Settings } from "../settings/settings";
import { defaultThemes, selectedTheme, themeBase } from "../settings/theme";
import grammar from "./pawn/pawn.tmLanguage.json?raw";
import languageConfiguration from "./pawn/language-configuration.json?raw";
import "monaco-editor/esm/vs/editor/edcore.main";
import type { ITextEditorOptions } from "@codingame/monaco-vscode-api/vscode/vs/platform/editor/common/editor";
import { NativeReadProvider } from "./native-files";
import { OpenFileProvider } from "./open-files";
import { installWorkspaceEdits } from "./workspace-edits";

export const files = new OpenFileProvider();
registerFileSystemOverlay(1, files);
registerFileSystemOverlay(-1, new NativeReadProvider(false));
let started: Promise<void> | undefined;

function configuration(settings: Settings) {
  const theme = selectedTheme(settings);
  const custom = settings.theme === "custom";
  return {
    "workbench.colorTheme": custom
      ? `ompide Imported ${theme.type}`
      : defaultThemes[themeBase(theme)].name,
    "workbench.colorCustomizations": custom ? theme.colors : {},
    "editor.tokenColorCustomizations": custom
      ? { textMateRules: theme.tokenColors }
      : {},
    "editor.semanticHighlighting.enabled": theme.semanticHighlighting ?? true,
    "editor.semanticTokenColorCustomizations": custom
      ? {
          enabled: theme.semanticHighlighting ?? true,
          rules: theme.semanticTokenColors ?? {},
        }
      : {},
    "telemetry.telemetryLevel": "off",
    "workbench.enableExperiments": false,
    "editor.fontSize": settings.fontSize,
    "editor.fontFamily": settings.fontFamily,
    "editor.tabSize": settings.tabSize,
    "editor.insertSpaces": settings.insertSpaces,
    "editor.wordWrap": settings.wordWrap ? "on" : "off",
    "editor.minimap.enabled": settings.minimap,
    "editor.wordBasedSuggestions": "off",
    // The pinned TextMate worker can apply stale state deltas after a large edit/theme
    // change. Use its standard, time-sliced tokenizer until the worker race is fixed.
    "editor.experimental.asyncTokenization": false,
  };
}

export function initializeEditor(
  settings: Settings,
  openEditor: (uri: string, line?: number, column?: number) => Promise<void>,
  prepareEdits: (uris: string[]) => Promise<void>,
  report: (error: unknown) => void
): Promise<void> {
  return (started ??= (async () => {
    const themeFiles = new Map<string, string | URL>();
    const importedTypes = ["light", "dark", "hcLight", "hcDark"] as const;
    for (const type of importedTypes)
      themeFiles.set(
        `/import-${type}.json`,
        JSON.stringify({
          name: `ompide Imported ${type}`,
          type,
          colors: defaultThemes[themeBase({ type })].colors,
          tokenColors: [],
        })
      );
    for (const [id, theme] of Object.entries(defaultThemes))
      themeFiles.set(
        `/${id}.json`,
        JSON.stringify({
          name: theme.name,
          colors: theme.colors,
          tokenColors: theme.tokenColors,
        })
      );
    const wrapper = new MonacoVscodeApiWrapper({
      $type: "extended",
      logLevel: LogLevel.Error,
      viewsConfig: {
        $type: "EditorService",
        openEditorFunc: async (modelRef, options) => {
          const selection = (options as ITextEditorOptions | undefined)
            ?.selection;
          await openEditor(
            modelRef.object.textEditorModel.uri.toString(),
            selection?.startLineNumber,
            selection?.startColumn
          );
          return undefined;
        },
      },
      serviceOverrides: { ...getKeybindingsServiceOverride() },
      userConfiguration: { json: JSON.stringify(configuration(settings)) },
      advanced: { loadThemes: false },
      monacoWorkerFactory: configureWorkers,
      extensions: [
        {
          config: {
            name: "pawn-language",
            publisher: "ompide",
            version: "0.1.0",
            engines: { vscode: "*" },
            contributes: {
              languages: [
                {
                  id: "pawn",
                  aliases: ["Pawn"],
                  extensions: [".pwn", ".inc"],
                  configuration: "./language-configuration.json",
                },
              ],
              grammars: [
                {
                  language: "pawn",
                  scopeName: "source.pawn",
                  path: "./pawn.tmLanguage.json",
                },
              ],
            },
          },
          filesOrContents: new Map([
            ["/language-configuration.json", languageConfiguration],
            ["/pawn.tmLanguage.json", grammar],
          ]),
        },
        {
          config: {
            name: "pawn-themes",
            publisher: "ompide",
            version: "0.1.0",
            engines: { vscode: "*" },
            contributes: {
              themes: [
                ...Object.entries(defaultThemes).map(([id, theme]) => ({
                  id: theme.name,
                  label: theme.name,
                  uiTheme:
                    themeBase(theme) === "dark"
                      ? ("vs-dark" as const)
                      : ("vs" as const),
                  path: `./${id}.json`,
                })),
                ...importedTypes.map((type) => ({
                  id: `ompide Imported ${type}`,
                  label: `ompide Imported ${type}`,
                  uiTheme:
                    type === "hcDark"
                      ? ("hc-black" as const)
                      : type === "hcLight"
                        ? ("hc-light" as const)
                        : type === "dark"
                          ? ("vs-dark" as const)
                          : ("vs" as const),
                  path: `./import-${type}.json`,
                })),
              ],
            },
          },
          filesOrContents: themeFiles,
        },
      ],
    });
    await wrapper.start();
    await installWorkspaceEdits(prepareEdits, report);
  })());
}

export async function applyEditorSettings(settings: Settings): Promise<void> {
  await updateUserConfiguration(JSON.stringify(configuration(settings)));
}
