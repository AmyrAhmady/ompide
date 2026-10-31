import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./native";

export const projectLinks = {
  repository: "https://github.com/AmyrAhmady/ompide",
  author: "https://github.com/AmyrAhmady",
  donate: "https://donate.amii.ir",
} as const;

export type ProjectLink = keyof typeof projectLinks;

export async function openProjectLink(link: ProjectLink): Promise<void> {
  if (desktop) {
    await invoke<void>("open_help_link", { link });
  } else {
    window.open(projectLinks[link], "_blank", "noopener,noreferrer");
  }
}
