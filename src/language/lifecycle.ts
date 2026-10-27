interface DocumentState {
  opened: Promise<void>;
  resolveOpen: () => void;
  rejectOpen: (error: unknown) => void;
  changes: Promise<void>;
  disposed: boolean;
  opening: boolean;
}

/** Serialize document notifications above the transport, including concurrent delayed-open flushes. */
export class DocumentLifecycle {
  private documents = new Map<string, DocumentState>();
  private disposed = false;
  private state(uri: string): DocumentState {
    let state = this.documents.get(uri);
    if (!state) {
      let resolveOpen!: () => void;
      let rejectOpen!: (error: unknown) => void;
      const opened = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
      void opened.catch(() => undefined);
      state = { opened, resolveOpen, rejectOpen, changes: Promise.resolve(), disposed: false, opening: false };
      this.documents.set(uri, state);
    }
    return state;
  }
  async open(uri: string, send: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    const state = this.state(uri);
    // Pending-open flushes can re-enter while another open is being sent. The outer open
    // owns the barrier; duplicate calls must finish immediately to avoid recursive deadlock.
    if (state.opening) return;
    state.opening = true;
    try { await send(); state.resolveOpen(); }
    catch (error) { state.rejectOpen(error); throw error; }
  }
  track(uri: string): void { if (!this.disposed) this.state(uri); }
  change(uri: string, flushOpen: () => Promise<unknown>, send: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const state = this.state(uri);
    const change = state.changes.then(async () => {
      if (state.disposed) return;
      await flushOpen();
      await state.opened;
      if (!state.disposed) await send();
    });
    state.changes = change;
    return change;
  }
  async close(uri: string, send: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    const state = this.documents.get(uri);
    if (state) await state.changes;
    await send();
    this.documents.delete(uri);
  }
  async ready(uri: string): Promise<void> {
    const state = this.documents.get(uri);
    if (state) { await state.opened; await state.changes; }
  }
  async changes(): Promise<void> { await Promise.all([...this.documents.values()].map(state => state.changes)); }
  dispose(): void {
    this.disposed = true;
    for (const state of this.documents.values()) { state.disposed = true; state.resolveOpen(); }
    this.documents.clear();
  }
}

export function documentUri(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('textDocument' in params)) return;
  const document = params.textDocument;
  if (typeof document === 'object' && document !== null && 'uri' in document && typeof document.uri === 'string') return document.uri;
}
