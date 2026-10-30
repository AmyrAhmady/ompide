import dark from "./themes/dark.json";
import light from "./themes/light.json";

export type ThemeColor = keyof typeof dark.colors;

export interface Theme {
  schemaVersion: 1;
  name: string;
  base: "light" | "dark";
  colors: Record<ThemeColor, string>;
  tokenColors: { scope: string; settings: { foreground: string } }[];
}

export type ThemeChoice = "light" | "dark" | "custom";

export const themeSizeLimit = 256 * 1024;

export class ThemeError extends Error {
  readonly code: string;

  readonly parameters: Record<string, string>;

  constructor(code: string, parameters: Record<string, string> = {}) {
    super(code);
    this.code = code;
    this.parameters = parameters;
  }
}

export const defaultThemes: Record<"dark" | "light", Theme> = {
  dark: dark as Theme,
  light: light as Theme,
};
const hex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseTheme(value: unknown): Theme {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    (value.base !== "light" && value.base !== "dark") ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 64
  ) {
    throw new ThemeError("themeHeader");
  }
  const base = value.base as "light" | "dark";
  const defaults = defaultThemes[base];
  const colors = { ...defaults.colors };
  if (value.colors !== undefined) {
    if (!object(value.colors)) throw new ThemeError("themeColors");
    for (const [key, color] of Object.entries(value.colors)) {
      if (
        !Object.prototype.hasOwnProperty.call(colors, key) ||
        typeof color !== "string" ||
        !hex.test(color)
      )
        throw new ThemeError("themeColor", { token: key });
      colors[key as ThemeColor] = color;
    }
  }
  let tokenColors = defaults.tokenColors;
  if (value.tokenColors !== undefined) {
    if (!Array.isArray(value.tokenColors) || value.tokenColors.length > 500)
      throw new ThemeError("themeSyntax");
    tokenColors = value.tokenColors.map((rule: unknown) => {
      if (
        !object(rule) ||
        typeof rule.scope !== "string" ||
        !rule.scope.trim() ||
        [...rule.scope].some((character) => character.charCodeAt(0) < 32) ||
        rule.scope.length > 256 ||
        !object(rule.settings) ||
        typeof rule.settings.foreground !== "string" ||
        !/^#[0-9a-fA-F]{6}$/.test(rule.settings.foreground)
      )
        throw new ThemeError("themeSyntax");
      return {
        scope: rule.scope,
        settings: { foreground: rule.settings.foreground },
      };
    });
  }
  return {
    schemaVersion: 1,
    name: value.name.trim(),
    base,
    colors,
    tokenColors,
  };
}

export function parseThemeText(text: string): Theme {
  if (new TextEncoder().encode(text).length > themeSizeLimit)
    throw new ThemeError("themeSize");
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ThemeError("themeJson");
  }
  return parseTheme(value);
}

export function selectedTheme(settings: {
  theme: ThemeChoice;
  customTheme: Theme | null;
}): Theme {
  return settings.theme === "custom"
    ? (settings.customTheme ?? defaultThemes.dark)
    : defaultThemes[settings.theme];
}

export function themeVariables(theme: Theme): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme.colors).map(([token, color]) => [
      `--${token.replaceAll(".", "-")}`,
      color,
    ])
  );
}
