import type { ServerCapabilities } from 'vscode-languageclient/browser';

export function languageFeatures(capabilities: ServerCapabilities) {
  return {
    completion: Boolean(capabilities.completionProvider),
    hover: Boolean(capabilities.hoverProvider),
    signatureHelp: Boolean(capabilities.signatureHelpProvider),
    definition: Boolean(capabilities.definitionProvider),
    references: Boolean(capabilities.referencesProvider),
    rename: Boolean(capabilities.renameProvider),
    symbols: Boolean(capabilities.documentSymbolProvider),
    workspaceSymbols: Boolean(capabilities.workspaceSymbolProvider),
    folding: Boolean(capabilities.foldingRangeProvider),
    formatting: Boolean(capabilities.documentFormattingProvider),
    codeActions: Boolean(capabilities.codeActionProvider),
  };
}
export type LanguageFeatures = ReturnType<typeof languageFeatures>;
