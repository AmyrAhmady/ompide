import type { FileSnapshot, ToolInfo } from "../lib/native";
import type { BuildErrorDetails } from "./errors";

export interface Discovery {
  manifests: string[];
  entries: string[];
  truncated: boolean;
}

export interface ProjectInfo {
  project: {
    root: string;
    manifest: string;
    entry: string;
    profile: string;
    build: string;
  };
  manifest: FileSnapshot;
  configuration: unknown;
}

export interface BuildTools {
  compiler: ToolInfo;
}

export interface BuildSelection {
  root: string;
  entry: string;
  revision: string;
  build: string;
  profile: string;
}

export interface BuildEvent {
  id: number;
  stage: "preparing" | "compiling";
}

export interface BuildDiagnostic {
  code: string;
  severity: string;
  message: string;
  primary: {
    uri: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
}

export interface BuildReport {
  status: "passed" | "failed" | "cancelled";
  artifacts: { path: string; size: number }[];
  diagnostics: BuildDiagnostic[];
  process: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
  };
}

export interface BuildResult {
  outcome:
    "completed" | "cancelled" | "timeout" | "outputLimit" | "invalidArtifact";
  report: BuildReport | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface BuildState {
  phase:
    | "idle"
    | "saving"
    | "preparing"
    | "compiling"
    | "passed"
    | "failed"
    | "cancelled";
  id?: number;
  result?: BuildResult;
  error?: string;
  errorDetails?: BuildErrorDetails;
  entry?: string;
  output?: string;
  started?: number;
  elapsed?: number;
}

export const building = (state: BuildState) =>
  state.phase === "saving" ||
  state.phase === "preparing" ||
  state.phase === "compiling";
