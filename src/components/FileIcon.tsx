import type { CSSProperties } from "react";
import { fileIcons } from "./icons/file-icons";

/** Seti's own bundled icon font and filename/extension associations. */
export function FileIcon({ name }: { name: string }) {
  const icons = fileIcons(name);
  return (
    <span
      className="file-icon"
      aria-hidden="true"
      data-file-icon={icons.dark.id}
      style={
        {
          "--file-icon-dark": icons.dark.color,
          "--file-icon-light": icons.light.color,
        } as CSSProperties
      }
    >
      {icons.dark.character}
    </span>
  );
}
