/** Alternative model versions return to the saved value after undo. A save records its captured version. */
export class BufferVersion {
  constructor(
    public current: number,
    public saved = current
  ) {}

  get dirty(): boolean {
    return this.current !== this.saved;
  }

  changed(version: number): void {
    this.current = version;
  }

  savedAt(capturedVersion: number): void {
    this.saved = capturedVersion;
  }
}
