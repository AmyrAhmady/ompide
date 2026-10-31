import { parse, type ParseError } from "jsonc-parser";
import dark from "./themes/dark.json";
import light from "./themes/light.json";
import { t } from "../lib/i18n";

export type ThemeType = "dark" | "light" | "hcDark" | "hcLight";

export interface TokenRule {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface SemanticStyle {
  foreground?: string;
  fontStyle?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

/** Resolved VS Code theme data, never extension code. */
export interface Theme {
  name: string;
  type: ThemeType;
  colors: Record<string, string>;
  tokenColors: TokenRule[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, string | SemanticStyle>;
}

export type ThemeChoice = "light" | "dark" | "custom";

export const themeSizeLimit = 2 * 1024 * 1024;

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

export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function themeBase(theme: Pick<Theme, "type">): "light" | "dark" {
  return theme.type === "light" || theme.type === "hcLight" ? "light" : "dark";
}

function color(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
  )
    throw new ThemeError("themeColors");
  return value.length <= 5
    ? "#" + [...value.slice(1)].map((part) => part + part).join("")
    : value;
}

export function themeJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > themeSizeLimit)
    throw new ThemeError("themeSize");
  const errors: ParseError[] = [];
  const value: unknown = parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !object(value)) throw new ThemeError("themeJson");
  return value;
}

export function parseTheme(
  value: unknown,
  label = t("theme.importedName"),
  type: ThemeType = "dark"
): Theme {
  if (!object(value)) throw new ThemeError("themeHeader");
  // Compatibility for saved preferences; new theme files use VS Code's type field.
  const kind = value.type ?? value.base ?? type;
  if (!["light", "dark", "hcLight", "hcDark"].includes(String(kind)))
    throw new ThemeError("themeHeader");
  const name = value.name ?? label;
  if (typeof name !== "string" || !name.trim() || name.length > 256)
    throw new ThemeError("themeHeader");
  if (value.include !== undefined) throw new ThemeError("themeInclude");
  const defaults = defaultThemes[themeBase({ type: kind as ThemeType })];
  const colors = { ...defaults.colors };
  if (value.colors !== undefined) {
    if (!object(value.colors)) throw new ThemeError("themeColors");
    for (const [key, entry] of Object.entries(value.colors)) {
      if (
        !/^[a-zA-Z][\w.-]{0,255}$/.test(key) ||
        ["constructor", "prototype", "__proto__"].includes(key)
      )
        throw new ThemeError("themeColor", { token: key });
      if (entry !== null) colors[key] = color(entry);
    }
  }
  let tokenColors = defaults.tokenColors;
  if (value.tokenColors !== undefined) {
    if (!Array.isArray(value.tokenColors) || value.tokenColors.length > 10000)
      throw new ThemeError("themeSyntax");
    tokenColors = value.tokenColors.map((rule: unknown) => {
      if (!object(rule) || !object(rule.settings))
        throw new ThemeError("themeSyntax");
      const scopes =
        rule.scope === undefined
          ? []
          : Array.isArray(rule.scope)
            ? rule.scope
            : [rule.scope];
      if (
        scopes.some(
          (scope) =>
            typeof scope !== "string" ||
            !scope.trim() ||
            scope.length > 2048 ||
            [...scope].some((character) => character.charCodeAt(0) < 32)
        )
      )
        throw new ThemeError("themeSyntax");
      const settings: TokenRule["settings"] = {};
      if (rule.settings.foreground !== undefined)
        settings.foreground = color(rule.settings.foreground);
      if (rule.settings.background !== undefined)
        settings.background = color(rule.settings.background);
      if (rule.settings.fontStyle !== undefined) {
        if (
          typeof rule.settings.fontStyle !== "string" ||
          !/^(\s*(italic|bold|underline|strikethrough))*\s*$/.test(
            rule.settings.fontStyle
          )
        )
          throw new ThemeError("themeSyntax");
        settings.fontStyle = rule.settings.fontStyle;
      }
      return {
        ...(typeof rule.name === "string"
          ? { name: rule.name.slice(0, 256) }
          : {}),
        ...(rule.scope === undefined
          ? {}
          : { scope: rule.scope as string | string[] }),
        settings,
      };
    });
  }
  const semanticTokenColors: NonNullable<Theme["semanticTokenColors"]> = {};
  if (value.semanticTokenColors !== undefined) {
    if (!object(value.semanticTokenColors)) throw new ThemeError("themeSyntax");
    for (const [selector, style] of Object.entries(value.semanticTokenColors)) {
      if (
        !/^[\w*.-]+(?::[\w-]+)?$/.test(selector) ||
        ["__proto__", "constructor", "prototype"].includes(selector)
      )
        throw new ThemeError("themeSyntax");
      if (typeof style === "string")
        semanticTokenColors[selector] = color(style);
      else {
        if (!object(style)) throw new ThemeError("themeSyntax");
        const result: SemanticStyle = {};
        if (style.fontStyle !== undefined) {
          if (
            typeof style.fontStyle !== "string" ||
            !/^(\s*(italic|bold|underline|strikethrough))*\s*$/.test(
              style.fontStyle
            )
          )
            throw new ThemeError("themeSyntax");
          result.fontStyle = style.fontStyle;
        }
        if (style.foreground !== undefined)
          result.foreground = color(style.foreground);
        for (const key of [
          "bold",
          "italic",
          "underline",
          "strikethrough",
        ] as const) {
          if (style[key] !== undefined) {
            if (typeof style[key] !== "boolean")
              throw new ThemeError("themeSyntax");
            result[key] = style[key];
          }
        }
        semanticTokenColors[selector] = result;
      }
    }
  }
  if (
    value.semanticHighlighting !== undefined &&
    typeof value.semanticHighlighting !== "boolean"
  )
    throw new ThemeError("themeSyntax");
  return {
    name: name.trim(),
    type: kind as ThemeType,
    colors,
    tokenColors,
    ...(typeof value.semanticHighlighting === "boolean"
      ? { semanticHighlighting: value.semanticHighlighting }
      : {}),
    ...(value.semanticTokenColors ? { semanticTokenColors } : {}),
  };
}

export function parseThemeText(text: string): Theme {
  return parseTheme(themeJson(text));
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
  const c = theme.colors;
  const colors = {
    ...c,
    "windowControl.closeBackground":
      c["button.hoverBackground"] ?? c["button.background"],
    "windowControl.closeForeground": c["button.foreground"],
    "panelTab.activeBackground": c["tab.activeBackground"],
    "panelTab.activeForeground":
      c["panelTitle.activeForeground"] ?? c["editor.foreground"],
    "toolbar.buttonBackground":
      c["button.secondaryBackground"] ?? c["editorWidget.background"],
    "toolbar.buttonHoverBackground":
      c["toolbar.hoverBackground"] ?? c["list.hoverBackground"],
    "toolbar.buttonBorder": c["widget.border"] ?? c["input.border"],
  };
  return Object.fromEntries(
    Object.entries(colors).map(([token, value]) => [
      `--${token.replaceAll(".", "-")}`,
      value,
    ])
  );
}
