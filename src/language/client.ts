import { Channel, invoke } from '@tauri-apps/api/core';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction, ErrorCodes, ResponseError } from 'vscode-languageclient/browser';
import { Uri, workspace } from 'vscode';
import { IpcMessageReader, IpcMessageWriter, type LspEvent } from './transport';
import { protocolUri } from '../lib/uri';
import { DocumentLifecycle, documentUri } from './lifecycle';

export interface LanguageSession { client: MonacoLanguageClient; stop(): Promise<void> }

export async function startLanguageSession(root: string, document: string | undefined, onClosed: () => void): Promise<LanguageSession> {
  let stopping = false;
  const lifecycle = new DocumentLifecycle();
  const reader = new IpcMessageReader();
  const events = new Channel<LspEvent>(event => {
    if (event.kind === 'stderr') console.warn(event.body);
    if (event.kind === 'error') console.error(event.body);
    // stop() owns disposal after shutdown/exit. An early EOF must not be reported as a crash.
    if (event.kind === 'closed' && stopping) return;
    reader.accept(event);
  });
  const sessionId = await invoke<number>('lsp_start', { document, onEvent: events });
  const writer = new IpcMessageWriter(body => invoke<void>('lsp_send', { sessionId, body }));
  const client: MonacoLanguageClient = new MonacoLanguageClient({
    id: 'pawn', name: 'Pawn', messageTransports: { reader, writer },
    clientOptions: {
      documentSelector: [{ language: 'pawn', scheme: 'file' }],
      uriConverters: { code2Protocol: protocolUri, protocol2Code: value => Uri.parse(value) },
      workspaceFolder: { uri: Uri.file(root), name: root.split(/[\\/]/).at(-1) ?? root, index: 0 },
      synchronize: { configurationSection: 'pawn' },
      diagnosticPullOptions: { onChange: true, onSave: true, onFocus: true },
      textSynchronization: { delayOpenNotifications: false },
      middleware: {
        didOpen: (document, next) => lifecycle.open(protocolUri(document.uri), () => next(document)),
        didChange: (event, next) => lifecycle.change(protocolUri(event.document.uri), async () => { await client.getFeature('textDocument/didOpen').getProvider(event.document)?.send(event.document); }, () => next(event)),
        didClose: (document, next) => lifecycle.close(protocolUri(document.uri), () => next(document)),
        sendRequest: async (type, params, token, next) => {
          const inactive = () => new ResponseError(ErrorCodes.ConnectionInactive, 'Language session stopped');
          if (stopping) throw inactive();
          const uri = documentUri(params);
          if (uri) await lifecycle.ready(uri);
          if (stopping) throw inactive();
          try { return await next(type, params, token); }
          catch (error) { if (stopping) throw inactive(); throw error; }
        },
        sendNotification: async (type, next, params) => {
          const method = typeof type === 'string' ? type : type.method;
          if (method === 'workspace/didChangeWatchedFiles') await lifecycle.changes();
          else if (method === 'textDocument/didSave') {
            const uri = documentUri(params);
            if (uri) await lifecycle.ready(uri);
          }
          return next(type, params);
        },
      },
      errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => ({ action: CloseAction.DoNotRestart }) },
    },
  });
  reader.onClose(() => { if (!stopping) onClosed(); });
  for (const document of workspace.textDocuments) if (document.uri.scheme === 'file' && document.languageId === 'pawn') lifecycle.track(protocolUri(document.uri));
  try {
    await client.start();
    for (const document of workspace.textDocuments) await client.getFeature('textDocument/didOpen').getProvider(document)?.send(document);
  }
  catch (error) { stopping = true; lifecycle.dispose(); await invoke('lsp_stop', { sessionId }); reader.dispose(); writer.dispose(); throw error; }
  return {
    client,
    async stop() {
      stopping = true;
      lifecycle.dispose();
      try { if (client.isRunning()) await client.stop(3000); }
      finally { await invoke('lsp_stop', { sessionId }); reader.dispose(); writer.dispose(); }
    },
  };
}
