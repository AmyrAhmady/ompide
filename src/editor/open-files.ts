import { Emitter, type Uri } from "monaco-editor";
import {
  FileType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  type IFileChange,
  type IFileSystemProviderWithFileReadWriteCapability,
} from "@codingame/monaco-vscode-files-service-override";

/** Flat URI-keyed editor buffers also support Windows drive roots, without synthesizing directories. */
export class OpenFileProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite;

  private changes = new Emitter<readonly IFileChange[]>();

  readonly onDidChangeFile = this.changes.event;

  private capabilitiesChanged = new Emitter<void>();

  readonly onDidChangeCapabilities = this.capabilitiesChanged.event;

  private buffers = new Map<string, Uint8Array>();

  register(uri: Uri, text: string) {
    const key = uri.toString();
    if (this.buffers.has(key)) throw new Error("Buffer already registered");
    this.buffers.set(key, new TextEncoder().encode(text));
    return {
      dispose: () => {
        this.buffers.delete(key);
      },
    };
  }

  update(uri: Uri, text: string): void {
    this.buffers.set(uri.toString(), new TextEncoder().encode(text));
  }

  private bytes(uri: Uri): Uint8Array {
    const bytes = this.buffers.get(uri.toString());
    if (!bytes)
      throw FileSystemProviderError.create(
        uri.toString(),
        FileSystemProviderErrorCode.FileNotFound
      );
    return bytes;
  }

  async stat(uri: Uri) {
    return {
      type: FileType.File,
      ctime: 0,
      mtime: 0,
      size: this.bytes(uri).length,
    };
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    return this.bytes(uri);
  }

  watch() {
    return { dispose() {} };
  }

  async readdir(): Promise<[string, FileType][]> {
    return [];
  }

  async writeFile(): Promise<void> {
    throw FileSystemProviderError.create(
      "explicit native save required",
      FileSystemProviderErrorCode.NoPermissions
    );
  }

  async mkdir(): Promise<void> {
    throw FileSystemProviderError.create(
      "explicit workspace action required",
      FileSystemProviderErrorCode.NoPermissions
    );
  }

  async delete(): Promise<void> {
    throw FileSystemProviderError.create(
      "explicit workspace action required",
      FileSystemProviderErrorCode.NoPermissions
    );
  }

  async rename(): Promise<void> {
    throw FileSystemProviderError.create(
      "explicit workspace action required",
      FileSystemProviderErrorCode.NoPermissions
    );
  }
}
