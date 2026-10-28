// Based on TypeFox's extended EditorService example (11.0.3); no VS Code workbench UI.
import { LogLevel } from '@codingame/monaco-vscode-api';
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override';
import { updateUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override';
import { registerFileSystemOverlay } from '@codingame/monaco-vscode-files-service-override';
import { MonacoVscodeApiWrapper } from 'monaco-languageclient/vscodeApiWrapper';
import { configureWorkers } from './workers';
import type { Settings } from '../settings/settings';
import { defaultThemes } from '../settings/theme';
import grammar from './pawn/pawn.tmLanguage.json?raw';
import languageConfiguration from './pawn/language-configuration.json?raw';
import 'monaco-editor/esm/vs/editor/edcore.main';
import type { ITextEditorOptions } from '@codingame/monaco-vscode-api/vscode/vs/platform/editor/common/editor';
import { NativeReadProvider } from './native-files';
import { OpenFileProvider } from './open-files';
import { installWorkspaceEdits } from './workspace-edits';

export const files = new OpenFileProvider();
registerFileSystemOverlay(1, files);
registerFileSystemOverlay(-1, new NativeReadProvider(false));
let started: Promise<void> | undefined;

function configuration(settings: Settings) {
  return {
    'workbench.colorTheme': defaultThemes[settings.theme].name,
    'telemetry.telemetryLevel': 'off', 'workbench.enableExperiments': false,
    'editor.fontSize': settings.fontSize, 'editor.fontFamily': settings.fontFamily,
    'editor.tabSize': settings.tabSize, 'editor.insertSpaces': settings.insertSpaces,
    'editor.wordWrap': settings.wordWrap ? 'on' : 'off',
    'editor.minimap.enabled': settings.minimap, 'editor.wordBasedSuggestions': 'off',
    'editor.experimental.asyncTokenization': true,
  };
}

export function initializeEditor(settings: Settings, openEditor: (uri: string, line?: number, column?: number) => Promise<void>, prepareEdits: (uris: string[]) => Promise<void>, report: (error: unknown) => void): Promise<void> {
  return started ??= (async () => {
    const themeFiles = new Map<string, string | URL>();
    for (const [id, theme] of Object.entries(defaultThemes)) themeFiles.set(`/${id}.json`, JSON.stringify({ name: theme.name, colors: theme.colors, tokenColors: theme.tokenColors }));
    const wrapper = new MonacoVscodeApiWrapper({
      $type: 'extended', logLevel: LogLevel.Error,
      viewsConfig: { $type: 'EditorService', openEditorFunc: async (modelRef, options) => {
        const selection = (options as ITextEditorOptions | undefined)?.selection;
        await openEditor(modelRef.object.textEditorModel.uri.toString(), selection?.startLineNumber, selection?.startColumn);
        return undefined;
      } },
      serviceOverrides: { ...getKeybindingsServiceOverride() },
      userConfiguration: { json: JSON.stringify(configuration(settings)) },
      advanced: { loadThemes: false },
      monacoWorkerFactory: configureWorkers,
      extensions: [
        {
          config: {
            name: 'pawn-language', publisher: 'pawn-ide', version: '0.1.0', engines: { vscode: '*' },
            contributes: {
              languages: [{ id: 'pawn', aliases: ['Pawn'], extensions: ['.pwn', '.inc'], configuration: './language-configuration.json' }],
              grammars: [{ language: 'pawn', scopeName: 'source.pawn', path: './pawn.tmLanguage.json' }],
            },
          },
          filesOrContents: new Map([['/language-configuration.json', languageConfiguration], ['/pawn.tmLanguage.json', grammar]]),
        },
        {
          config: {
            name: 'pawn-themes', publisher: 'pawn-ide', version: '0.1.0', engines: { vscode: '*' },
            contributes: { themes: Object.entries(defaultThemes).map(([id, theme]) => ({ id: theme.name, label: theme.name, uiTheme: theme.base === 'dark' ? 'vs-dark' : 'vs', path: `./${id}.json` })) },
          },
          filesOrContents: themeFiles,
        },
      ],
    });
    await wrapper.start();
    await installWorkspaceEdits(prepareEdits, report);
  })();
}

export async function applyEditorSettings(settings: Settings): Promise<void> {
  await updateUserConfiguration(JSON.stringify(configuration(settings)));
}
