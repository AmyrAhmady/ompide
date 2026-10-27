import { describe, expect, it } from 'vitest';
import { IpcMessageReader, IpcMessageWriter } from './transport';
import type { RequestMessage } from 'vscode-jsonrpc';

const request = (id: number, method: string): RequestMessage => ({ jsonrpc: '2.0', id, method });

describe('IPC MessageTransports', () => {
  it('queues early messages and preserves numeric/string response IDs and Unicode', () => {
    const reader = new IpcMessageReader();
    const messages = [{ jsonrpc: '2.0', id: 'first', result: '🦀\r\n' }, { jsonrpc: '2.0', id: 2, result: null }];
    for (const message of messages) reader.accept({ kind: 'message', body: JSON.stringify(message) });
    const received: unknown[] = [];
    reader.listen(message => received.push(message));
    expect(received).toEqual(messages);
    reader.dispose();
  });

  it('separates stderr, protocol errors, malformed messages and process closure', () => {
    const reader = new IpcMessageReader();
    const errors: Error[] = [];
    const received: unknown[] = [];
    let closed = 0;
    reader.onError(error => errors.push(error));
    reader.onClose(() => closed++);
    reader.listen(message => received.push(message));
    reader.accept({ kind: 'stderr', body: 'not JSON' });
    reader.accept({ kind: 'message', body: 'not JSON' });
    reader.accept({ kind: 'error', body: 'process failed' });
    reader.accept({ kind: 'closed' });
    reader.accept({ kind: 'closed' });
    expect(errors).toHaveLength(2);
    expect(received).toEqual([]);
    expect(closed).toBe(1);
  });

  it('serializes asynchronous writes and reports a failed send without losing the next message', async () => {
    const written: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = new IpcMessageWriter(async body => {
      const { id } = JSON.parse(body) as { id: number };
      if (id === 1) await gate;
      written.push(body);
      if (id === 2) throw new Error('write failed');
    });
    let errors = 0;
    writer.onError(() => errors++);
    const first = writer.write(request(1, 'initialize'));
    const second = writer.write(request(2, 'shutdown'));
    const failure = expect(second).rejects.toThrow('write failed');
    const third = writer.write(request(3, 'exit'));
    await Promise.resolve();
    expect(written).toEqual([]);
    release?.();
    await first;
    await failure;
    await third;
    expect(written.map(body => (JSON.parse(body) as { id: number }).id)).toEqual([1, 2, 3]);
    expect(errors).toBe(1);
    writer.end();
    await expect(writer.write(request(4, 'exit'))).rejects.toThrow('closed');
  });
});
