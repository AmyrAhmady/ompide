/** Filesystem path identity for Windows drives/UNC; POSIX paths retain case. */
export function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function withinPath(path: string, parent: string): boolean {
  const key = pathKey(path);
  const root = pathKey(parent).replace(/\/+$/, "");
  return key === root || key.startsWith(root + "/");
}

export function parentPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:/.test(normalized))
    return normalized.slice(0, 3);
  return index < 0 ? path : normalized.slice(0, index);
}

export const fileName = (path: string) =>
  path
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .at(-1) || path;

export const childPath = (parent: string, name: string) =>
  parent.replace(/[/\\]+$/, "") + "/" + name;
