import { unzip } from "fflate";
import {
  object,
  parseTheme,
  themeJson,
  ThemeError,
  themeSizeLimit,
  type Theme,
  type ThemeType,
} from "./theme";

export const packageSizeLimit = 24 * 1024 * 1024;

export interface InstalledTheme {
  id: string;
  theme: Theme;
  publisher?: string;
  version?: string;
  license?: string;
}

export function relativeThemePath(from: string, path: string): string {
  if (
    !path ||
    /[\\:?#]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.startsWith("/")
  )
    throw new ThemeError("themeInclude");
  const parts = from.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (!parts.length) throw new ThemeError("themeInclude");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function plist(text: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    // Common plist DOCTYPE is descriptive only. Strip it, never resolve entities.
    text = text.replace(/<!DOCTYPE[^>]*>/gi, "");
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ThemeError("themeJson");
  }
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) throw new ThemeError("themeJson");
  let nodes = 0;

  const read = (element: Element, depth = 0): unknown => {
    if (++nodes > 100000 || depth > 32) throw new ThemeError("themeSize");
    if (element.tagName === "dict") {
      const result: Record<string, unknown> = Object.create(null);
      const children = [...element.children];
      for (let i = 0; i < children.length; i += 2) {
        if (children[i].tagName !== "key" || !children[i + 1])
          throw new ThemeError("themeJson");
        result[children[i].textContent ?? ""] = read(
          children[i + 1],
          depth + 1
        );
      }
      return result;
    }
    if (element.tagName === "array")
      return [...element.children].map((child) => read(child, depth + 1));
    if (element.tagName === "string") return element.textContent ?? "";
    if (element.tagName === "true" || element.tagName === "false")
      return element.tagName === "true";
    throw new ThemeError("themeJson");
  };
  const root = document.documentElement;
  const content = root.tagName === "plist" ? root.firstElementChild : root;
  if (!content) throw new ThemeError("themeJson");
  const result = read(content);
  if (!object(result) || !Array.isArray(result.settings))
    throw new ThemeError("themeJson");
  const global = result.settings.find(
    (rule: unknown) => object(rule) && rule.scope === undefined
  );
  const colors: Record<string, unknown> = {};
  if (object(global) && object(global.settings)) {
    for (const [key, target] of Object.entries({
      foreground: "editor.foreground",
      background: "editor.background",
      caret: "editorCursor.foreground",
      selection: "editor.selectionBackground",
      lineHighlight: "editor.lineHighlightBackground",
    })) {
      if (global.settings[key] !== undefined)
        colors[target] = global.settings[key];
    }
  }
  return { name: result.name, colors, tokenColors: result.settings };
}

/** Resolve includes only inside explicitly supplied files, never through URLs or native filesystem access. */
export function resolveTheme(
  files: Map<string, string>,
  path: string,
  label?: string,
  type?: ThemeType,
  stack: string[] = []
): Theme {
  if (stack.includes(path) || stack.length >= 16)
    throw new ThemeError("themeInclude");
  const text = files.get(path);
  if (text === undefined) throw new ThemeError("themeInclude");
  if (new TextEncoder().encode(text).length > themeSizeLimit)
    throw new ThemeError("themeSize");
  const raw = /\.tmTheme$/i.test(path) ? plist(text) : themeJson(text);
  if (!object(raw)) throw new ThemeError("themeJson");
  let parent: Theme | undefined;
  if (raw.include !== undefined) {
    if (typeof raw.include !== "string") throw new ThemeError("themeInclude");
    parent = resolveTheme(
      files,
      relativeThemePath(path, raw.include),
      label,
      type,
      [...stack, path]
    );
  }
  let rules = raw.tokenColors;
  if (typeof rules === "string") {
    const referenced = resolveTheme(
      files,
      relativeThemePath(path, rules),
      label,
      type,
      [...stack, path]
    );
    rules = referenced.tokenColors;
  }
  const merged: Record<string, unknown> = {
    ...parent,
    ...raw,
    name: label ?? raw.name ?? parent?.name,
    type: raw.type ?? parent?.type ?? type,
    colors: { ...parent?.colors, ...(object(raw.colors) ? raw.colors : {}) },
    tokenColors: [
      ...(parent?.tokenColors ?? []),
      ...(Array.isArray(rules) ? rules : []),
    ],
    semanticTokenColors: {
      ...parent?.semanticTokenColors,
      ...(object(raw.semanticTokenColors) ? raw.semanticTokenColors : {}),
    },
  };
  if (raw.colors !== undefined && !object(raw.colors))
    throw new ThemeError("themeColors");
  if (rules !== undefined && !Array.isArray(rules))
    throw new ThemeError("themeSyntax");
  if (raw.semanticTokenColors !== undefined && !object(raw.semanticTokenColors))
    throw new ThemeError("themeSyntax");
  delete merged.include;
  if (!parent && rules === undefined)
    delete (merged as Record<string, unknown>).tokenColors;
  return parseTheme(merged, label, type);
}

export function themesFromFiles(
  files: Map<string, string>,
  manifestPath = "extension/package.json"
): InstalledTheme[] {
  const manifest = themeJson(files.get(manifestPath) ?? "");
  if (
    !object(manifest) ||
    !object(manifest.contributes) ||
    !Array.isArray(manifest.contributes.themes)
  )
    throw new ThemeError("themePackage");
  const publisher =
    typeof manifest.publisher === "string"
      ? manifest.publisher.slice(0, 256)
      : "";
  const name =
    typeof manifest.name === "string" ? manifest.name.slice(0, 256) : "";
  const version =
    typeof manifest.version === "string" ? manifest.version.slice(0, 64) : "";
  const license =
    typeof manifest.license === "string"
      ? manifest.license.slice(0, 256)
      : undefined;
  if (manifest.contributes.themes.length > 64)
    throw new ThemeError("themeSize");
  return manifest.contributes.themes.map((entry, index) => {
    if (!object(entry) || typeof entry.path !== "string")
      throw new ThemeError("themePackage");
    const type: ThemeType =
      entry.uiTheme === "vs"
        ? "light"
        : entry.uiTheme === "hc-light"
          ? "hcLight"
          : entry.uiTheme === "hc-black"
            ? "hcDark"
            : "dark";
    const label =
      typeof entry.label === "string" && !entry.label.startsWith("%")
        ? entry.label
        : `${name} ${index + 1}`;
    return {
      id: `${publisher}.${name}:${entry.path}`,
      publisher,
      version,
      license,
      theme: resolveTheme(
        files,
        relativeThemePath(manifestPath, entry.path),
        label,
        type
      ),
    };
  });
}

export async function unpackThemes(
  bytes: Uint8Array
): Promise<InstalledTheme[]> {
  if (bytes.length > packageSizeLimit) throw new ThemeError("themeSize");
  let total = 0;
  let count = 0;
  const files = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      unzip(
        bytes,
        {
          filter: (file) => {
            if (++count > 10000) throw new ThemeError("themeSize");
            if (
              !/^extension\//.test(file.name) ||
              !/\.(?:json|jsonc|tmTheme)$/i.test(file.name)
            )
              return false;
            total += file.originalSize;
            if (file.originalSize > themeSizeLimit || total > packageSizeLimit)
              throw new ThemeError("themeSize");
            return true;
          },
        },
        (error, result) =>
          error ? reject(new ThemeError("themePackage")) : resolve(result)
      );
    }
  );
  return themesFromFiles(
    new Map(
      Object.entries(files).map(([name, bytes]) => [
        name,
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ])
    )
  );
}
