export interface ShellProfile {
  id: string;
  path: string;
  args: string[];
}

export interface TerminalInfo {
  id: number;
  pid: number;
  cwd: string;
}

export type TerminalEvent =
  | { kind: "data"; data: number[]; sequence: number }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; detail: string };
