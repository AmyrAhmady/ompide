export interface GitChange {
  path: string;
  original: string | null;
  index: string;
  working: string;
  conflict: boolean;
  submodule: boolean;
}

export interface GitSnapshot {
  head: string;
  revision: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
  branches: string[];
  tags: string[];
  stashes: string[];
  remotes: string[];
}

export interface GitDiff {
  before: string;
  after: string;
  unsupported: boolean;
}

export interface OpenGitDiff extends GitDiff {
  path: string;
  staged: boolean;
  unsaved: boolean;
}

export type GitAction =
  | { kind: "stage" | "unstage"; paths: string[] }
  | { kind: "commit"; message: string; amend: boolean }
  | { kind: "undo" }
  | {
      kind:
        "switch" | "createBranch" | "deleteBranch" | "createTag" | "deleteTag";
      name: string;
    }
  | { kind: "renameBranch"; name: string; newName: string }
  | { kind: "push" | "pull"; remote: string }
  | { kind: "pushTag"; remote: string; name: string }
  | { kind: "stash"; message: string }
  | { kind: "applyStash" | "popStash" | "dropStash"; name: string };

export type GitRequest =
  | { kind: "status" }
  | { kind: "diff"; path: string; staged: boolean }
  | { kind: "execute"; revision: string; action: GitAction };

export function changesFiles(changes: GitChange[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.original ? [change.path, change.original] : [change.path]
      )
    ),
  ];
}

export function changesWorkingTree(action: GitAction): boolean {
  return [
    "switch",
    "createBranch",
    "pull",
    "stash",
    "applyStash",
    "popStash",
  ].includes(action.kind);
}
