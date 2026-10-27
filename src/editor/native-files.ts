import { RegisteredFileSystemProvider, FileType, FileSystemProviderError, FileSystemProviderErrorCode, FileSystemProviderCapabilities } from '@codingame/monaco-vscode-files-service-override';
import type { Uri } from 'monaco-editor';
import { native } from '../lib/native';

/** Low-priority, read-through provider. Disk writes are exclusively explicit native save commands. */
export class NativeReadProvider extends RegisteredFileSystemProvider {
  override capabilities = FileSystemProviderCapabilities.FileReadWrite;
  override async readFile(resource: Uri): Promise<Uint8Array> {
    if (resource.scheme !== 'file') throw FileSystemProviderError.create('file URI required', FileSystemProviderErrorCode.FileNotFound);
    try { return new TextEncoder().encode((await native.read(resource.fsPath)).text); }
    catch { throw FileSystemProviderError.create(resource.toString(), FileSystemProviderErrorCode.FileNotFound); }
  }
  override async stat(resource: Uri) {
    const bytes = await this.readFile(resource);
    return { type: FileType.File, ctime: 0, mtime: 0, size: bytes.length };
  }
}
