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

export function reconcilePaths(
  paths: string[],
  source: string,
  target?: string
): string[] {
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    let next = path;
    if (withinPath(path, source)) {
      if (target === undefined) return [];
      const suffix = path
        .replaceAll("\\", "/")
        .slice(source.replaceAll("\\", "/").replace(/\/+$/, "").length);
      next = target + suffix;
    }
    const key = pathKey(next);
    if (seen.has(key)) return [];
    seen.add(key);
    return [next];
  });
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
