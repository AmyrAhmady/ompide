export interface EditorLocation {
  uri: string;
  line: number;
  column: number;
}

export type NavigationDirection = -1 | 1;

/** A session-local trail of meaningful editor locations, independent of tab order. */
export class NavigationHistory {
  private entries: EditorLocation[] = [];

  private index = -1;

  get canGoBack(): boolean {
    return this.index > 0;
  }

  get canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  record(location: EditorLocation, kind: "move" | "edit" | "jump"): void {
    const current = this.entries[this.index];
    if (
      current?.uri === location.uri &&
      (kind === "edit" ||
        (current.line === location.line &&
          current.column === location.column) ||
        (kind === "move" && Math.abs(current.line - location.line) < 10))
    ) {
      this.entries[this.index] = { ...location };
      return;
    }
    this.entries.splice(this.index + 1);
    this.entries.push({ ...location });
    if (this.entries.length > 200) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  peek(direction: NavigationDirection): EditorLocation | undefined {
    return this.entries[this.index + direction];
  }

  move(direction: NavigationDirection): void {
    if (this.peek(direction)) this.index += direction;
  }

  removeWhere(predicate: (location: EditorLocation) => boolean): void {
    const before = this.entries
      .slice(0, this.index + 1)
      .filter((location) => !predicate(location)).length;
    this.entries = this.entries.filter((location) => !predicate(location));
    this.index = Math.min(Math.max(0, before - 1), this.entries.length - 1);
  }

  replaceUri(before: string, after: string): void {
    this.entries = this.entries.map((location) =>
      location.uri === before ? { ...location, uri: after } : location
    );
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }
}
