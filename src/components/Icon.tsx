import add from "@vscode/codicons/src/icons/add.svg?url";
import remove from "@vscode/codicons/src/icons/remove.svg?url";
import close from "@vscode/codicons/src/icons/close.svg?url";
import circleFilled from "@vscode/codicons/src/icons/circle-filled.svg?url";
import chevronRight from "@vscode/codicons/src/icons/chevron-right.svg?url";
import chevronDown from "@vscode/codicons/src/icons/chevron-down.svg?url";
import folder from "@vscode/codicons/src/icons/folder.svg?url";
import folderOpened from "@vscode/codicons/src/icons/folder-opened.svg?url";
import newFile from "@vscode/codicons/src/icons/new-file.svg?url";
import newFolder from "@vscode/codicons/src/icons/new-folder.svg?url";
import refresh from "@vscode/codicons/src/icons/refresh.svg?url";
import target from "@vscode/codicons/src/icons/target.svg?url";
import files from "@vscode/codicons/src/icons/files.svg?url";
import search from "@vscode/codicons/src/icons/search.svg?url";
import sourceControl from "@vscode/codicons/src/icons/source-control.svg?url";
import trash from "@vscode/codicons/src/icons/trash.svg?url";
import error from "@vscode/codicons/src/icons/error.svg?url";
import warning from "@vscode/codicons/src/icons/warning.svg?url";

const icons = {
  add,
  remove,
  close,
  circleFilled,
  chevronRight,
  chevronDown,
  folder,
  folderOpened,
  newFile,
  newFolder,
  refresh,
  target,
  files,
  search,
  sourceControl,
  trash,
  error,
  warning,
};

export type IconName = keyof typeof icons;

/** Decorative bundled SVG; the enclosing control supplies its accessible name. */
export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`app-icon ${className}`}
      data-icon={name}
      style={{
        width: size,
        height: size,
        maskImage: `url("${icons[name]}")`,
      }}
    />
  );
}
