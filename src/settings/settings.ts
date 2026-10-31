import { defaultLayout, parseLayout, type Layout } from "./layout";
import { parseTheme, type Theme, type ThemeChoice } from "./theme";
import type { InstalledTheme } from "./theme-package";

export interface Settings {
  theme: ThemeChoice;
  customTheme: Theme | null;
  installedThemes: InstalledTheme[];
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
  languageServerPath: string;
  compilerPath: string;
  layout: Layout;
}

export const defaults: Settings = {
  theme: "dark",
  customTheme: null,
  installedThemes: [],
  fontSize: 14,
  fontFamily: 'Consolas, "Cascadia Code", monospace',
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  minimap: false,
  formatOnSave: false,
  languageServerPath: "",
  compilerPath: "",
  layout: { ...defaultLayout },
};

export function parseSettings(value: unknown): Settings {
  const settings = { ...defaults };
  if (typeof value !== "object" || value === null) return settings;
  const source = value as Record<string, unknown>;
  settings.layout = parseLayout(source.layout);
  if (Array.isArray(source.installedThemes)) {
    settings.installedThemes = source.installedThemes
      .slice(0, 64)
      .flatMap((entry: unknown) => {
        try {
          if (
            typeof entry !== "object" ||
            entry === null ||
            !("id" in entry) ||
            typeof entry.id !== "string" ||
            entry.id.length > 1024 ||
            !("theme" in entry)
          )
            return [];
          const metadata: Pick<
            InstalledTheme,
            "publisher" | "version" | "license"
          > = {};
          for (const key of ["publisher", "version", "license"] as const) {
            if (
              key in entry &&
              typeof entry[key as keyof typeof entry] === "string"
            )
              metadata[key] = String(entry[key as keyof typeof entry]).slice(
                0,
                256
              );
          }
          return [
            { id: entry.id, theme: parseTheme(entry.theme), ...metadata },
          ];
        } catch {
          return [];
        }
      });
  }
  if (source.theme === "light" || source.theme === "dark")
    settings.theme = source.theme;
  if (source.customTheme !== undefined && source.customTheme !== null) {
    try {
      settings.customTheme = parseTheme(source.customTheme);
      if (source.theme === "custom") settings.theme = "custom";
    } catch {
      // Invalid persisted data falls back to a usable built-in theme.
    }
  }
  for (const key of ["fontSize", "tabSize"] as const) {
    const maximum = key === "fontSize" ? 48 : 8;
    const minimum = key === "fontSize" ? 8 : 1;
    if (
      typeof source[key] === "number" &&
      Number.isInteger(source[key]) &&
      source[key] >= minimum &&
      source[key] <= maximum
    )
      settings[key] = source[key];
  }
  if (typeof source.fontFamily === "string" && source.fontFamily.length <= 256)
    settings.fontFamily = source.fontFamily;
  if (
    typeof source.languageServerPath === "string" &&
    source.languageServerPath.length <= 32768
  )
    settings.languageServerPath = source.languageServerPath;
  if (
    typeof source.compilerPath === "string" &&
    source.compilerPath.length <= 32768
  )
    settings.compilerPath = source.compilerPath;
  for (const key of [
    "insertSpaces",
    "wordWrap",
    "minimap",
    "formatOnSave",
  ] as const)
    if (typeof source[key] === "boolean") settings[key] = source[key];
  return settings;
}
