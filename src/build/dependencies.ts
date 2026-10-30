import type { FileSnapshot } from "../lib/native";

export interface DependencyReview {
  manifest: FileSnapshot;
  lockPath: string;
  lock: FileSnapshot | null;
  declarations: { specification: string; development: boolean }[];
  packages: {
    name: string;
    sourceType: "git" | "local";
    source: string;
    commit: string;
    checksum: string | null;
    destination: string;
  }[];
  resources: {
    package: string;
    name: string;
    target: string;
    url: string;
    checksum: string;
    destinations: string[];
  }[];
}
