export interface SearchOptions {
  query: string;
  fileQuery: string;
  matchCase: boolean;
  filesOnly: boolean;
}

export interface SearchOverlay {
  path: string;
  text: string;
  version: number;
  excluded?: boolean;
}

export interface SearchHit {
  line: number;
  column: number;
  endColumn: number;
  preview: string;
}

export interface SearchFile {
  path: string;
  uri: string;
  relative: string;
  revision: string;
  bufferVersion: number | null;
  hits: SearchHit[];
  before?: string;
  after?: string;
}

export interface SearchResult {
  files: SearchFile[];
  scanned: number;
  skipped: number;
  truncated: boolean;
  cancelled: boolean;
}
