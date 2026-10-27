import { Channel, invoke } from '@tauri-apps/api/core';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction } from 'vscode-languageclient/browser';
import { Uri } from 'vscode';
import { IpcMessageReader, IpcMessageWriter, type LspEvent } from './transport';
import { protocolUri } from '../lib/uri';

export interface LanguageSession { client: MonacoLanguageClient; stop(): Promise<void> }

export async function startLanguageSession(root: string, document: string | undefined, onClosed: () => void): Promise<LanguageSession> {
  let stopping = false;
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
  const client = new MonacoLanguageClient({
    id: 'pawn', name: 'Pawn', messageTransports: { reader, writer },
    clientOptions: {
      documentSelector: [{ language: 'pawn', scheme: 'file' }],
      uriConverters: { code2Protocol: protocolUri, protocol2Code: value => Uri.parse(value) },
      workspaceFolder: { uri: Uri.file(root), name: root.split(/[\\/]/).at(-1) ?? root, index: 0 },
      synchronize: { configurationSection: 'pawn' },
      diagnosticPullOptions: { onChange: true, onSave: true, onFocus: true },
      errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => ({ action: CloseAction.DoNotRestart }) },
    },
  });
  reader.onClose(() => { if (!stopping) onClosed(); });
  try { await client.start(); }
  catch (error) { await invoke('lsp_stop', { sessionId }); reader.dispose(); writer.dispose(); throw error; }
  return {
    client,
    async stop() {
      stopping = true;
      try { if (client.isRunning()) await client.stop(3000); }
      finally { await invoke('lsp_stop', { sessionId }); reader.dispose(); writer.dispose(); }
    },
  };
}
