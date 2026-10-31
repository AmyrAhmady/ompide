import { expect, it } from "vitest";
import {
  defaultThemes,
  parseTheme,
  parseThemeText,
  selectedTheme,
  ThemeError,
  themeSizeLimit,
  themeVariables,
} from "./theme";
import { defaults, parseSettings } from "./settings";
import pawnGrammar from "../editor/pawn/pawn.tmLanguage.json";

it("colors the Pawn grammar's token families in both default themes", () => {
  const scopes = new Set<string>();

  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "name" &&
        typeof child === "string" &&
        /^(comment|keyword|storage|entity|constant|variable)\./.test(child)
      )
        scopes.add(child);
      visit(child);
    }
  };
  visit(pawnGrammar);
  for (const theme of Object.values(defaultThemes))
    for (const scope of scopes) {
      const rules = theme.tokenColors.filter(
        (rule) =>
          scope === rule.scope ||
          (typeof rule.scope === "string" && scope.startsWith(`${rule.scope}.`))
      );
      expect(rules.length, `${theme.name}: missing ${scope}`).toBeGreaterThan(
        0
      );
      for (const rule of rules)
        expect(
          rule.settings.foreground,
          `${theme.name}: uncolored ${scope}`
        ).not.toBe(theme.colors["editor.foreground"]);
    }
});

it("provides complete light/dark defaults and custom overrides with fallback", () => {
  for (const theme of Object.values(defaultThemes))
    expect(parseTheme(theme)).toEqual(theme);
  const theme = parseTheme({
    name: "Custom",
    type: "dark",
    colors: { "editor.background": "#123456" },
  });
  expect(theme.colors["editor.background"]).toBe("#123456");
  expect(theme.colors["panel.border"]).toBe(
    defaultThemes.dark.colors["panel.border"]
  );
  expect(themeVariables(theme)["--editor-background"]).toBe("#123456");
});

it("persists validated custom themes and clears overrides when a default is selected", () => {
  const customTheme = parseThemeText(
    "\uFEFF" +
      JSON.stringify({
        name: "Ocean",
        type: "light",
        colors: { "editor.background": "#eaf7ff" },
      })
  );
  const settings = parseSettings(
    JSON.parse(JSON.stringify({ ...defaults, theme: "custom", customTheme }))
  );
  expect(selectedTheme(settings)).toEqual(customTheme);
  expect(selectedTheme({ ...settings, theme: "dark" })).toBe(
    defaultThemes.dark
  );
  expect(
    parseSettings({ theme: "custom", customTheme: { type: "invalid" } }).theme
  ).toBe("dark");
  expect(parseSettings({ theme: "custom" }).theme).toBe("dark");
});

it("rejects oversized or executable color content with actionable error codes", () => {
  expect(() => parseThemeText(" ".repeat(themeSizeLimit + 1))).toThrowError(
    expect.objectContaining({ code: "themeSize" })
  );
  expect(() => parseThemeText("{ trailing, }")).toThrowError(
    expect.objectContaining({ code: "themeJson" })
  );
  for (const colors of [
    { "editor.background": "url(https://example.com)" },
    { constructor: "#ffffff" },
  ]) {
    expect(() => parseTheme({ name: "Bad", type: "dark", colors })).toThrow(
      ThemeError
    );
  }
  expect(() =>
    parseTheme({
      name: "Bad",
      type: "dark",
      tokenColors: Array(10001).fill({
        scope: "keyword",
        settings: { foreground: "#ffffff" },
      }),
    })
  ).toThrowError(expect.objectContaining({ code: "themeSyntax" }));
});
it("rejects unsupported theme types, arbitrary CSS, and malformed syntax colors", () => {
  for (const value of [
    null,
    { type: "unknown" },
    {
      name: "Bad",
      type: "dark",
      colors: { "editor.background": "url(https://example.com)" },
    },
    { name: "Bad", type: "light", tokenColors: [{}] },
  ])
    expect(() => parseTheme(value)).toThrow();
});
