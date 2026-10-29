import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
} from "vscode-jsonrpc";

export type LspEvent =
  { kind: "message" | "stderr" | "error"; body: string } | { kind: "closed" };

/** Standard MessageTransports over complete Tauri channel messages. Rust handles stdio framing. */
export class IpcMessageReader extends AbstractMessageReader {
  constructor(private readonly observe?: (message: Message) => void) {
    super();
  }

  private callback?: DataCallback;

  private queue: Message[] = [];

  private closed = false;

  accept(event: LspEvent): void {
    if (this.closed) return;
    if (event.kind === "message") {
      try {
        const message: unknown = JSON.parse(event.body);
        if (
          typeof message !== "object" ||
          message === null ||
          !("jsonrpc" in message) ||
          message.jsonrpc !== "2.0"
        ) {
          throw new Error("Invalid JSON-RPC message");
        }
        this.observe?.(message as Message);
        if (this.callback) this.callback(message as Message);
        else this.queue.push(message as Message);
      } catch (error) {
        this.fireError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    } else if (event.kind === "error") this.fireError(new Error(event.body));
    else if (event.kind === "closed") {
      this.closed = true;
      this.fireClose();
    }
  }

  listen(callback: DataCallback): Disposable {
    if (this.callback) throw new Error("LSP reader is already listening");
    this.callback = callback;
    for (const message of this.queue) callback(message);
    this.queue = [];
    if (this.closed) this.fireClose();
    return {
      dispose: () => {
        this.callback = undefined;
        this.queue = [];
      },
    };
  }

  override dispose(): void {
    this.closed = true;
    this.queue = [];
    this.callback = undefined;
    super.dispose();
  }
}

export class IpcMessageWriter extends AbstractMessageWriter {
  private tail: Promise<void> = Promise.resolve();

  private closed = false;

  constructor(private readonly send: (body: string) => Promise<void>) {
    super();
  }

  write(message: Message): Promise<void> {
    if (this.closed) return Promise.reject(new Error("LSP writer closed"));
    const body = JSON.stringify(message);
    const write = this.tail.then(async () => {
      await this.send(body);
    });
    // Keep FIFO ordering, report failure and allow subsequent shutdown attempts.
    this.tail = write.catch((error: unknown) => {
      this.fireError(
        error instanceof Error ? error : new Error(String(error)),
        message
      );
    });
    return write;
  }

  end(): void {
    this.closed = true;
  }

  override dispose(): void {
    this.end();
    super.dispose();
  }
}
