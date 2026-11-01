import { describe, expect, it } from "vitest";
import { fileIcons } from "./file-icons";
import theme from "./seti/icon-theme.json";

describe("Seti file associations", () => {
  it("uses filename overrides and common language icons", () => {
    const examples = {
      "tsconfig.json": "_tsconfig",
      "eslint.config.js": "_eslint",
      "vite.config.ts": "_vite",
      "README.md": "_info",
      LICENSE: "_license",
      "package.json": "_json",
      ".gitignore": "_git",
      ".npmrc": "_npm_1",
      ".prettierrc.cjs": "_javascript",
      "script.ts": "_typescript",
      "main.rs": "_rust",
    };
    for (const [name, id] of Object.entries(examples)) {
      expect(fileIcons(name).dark.id, name).toBe(id);
      expect(fileIcons(`C:\\project\\${name.toUpperCase()}`).dark.id).toBe(id);
    }
  });

  it("prefers compound suffixes over generic language associations", () => {
    expect(fileIcons("src/example.test.js").dark.id).toBe("_javascript_1");
    expect(fileIcons("src/example.js").dark.id).toBe("_javascript");
  });

  it("falls back to Seti's default for unknown types and empty names", () => {
    for (const name of [
      "gungame.pwn",
      "custom.inc",
      "unknown.filetype",
      "",
      "file",
    ]) {
      expect(fileIcons(name).dark.id).toBe(theme.file);
    }
  });

  it("resolves supplied mappings to valid glyphs with matching light/dark shapes", () => {
    const names = [
      ...Object.keys(theme.fileNames),
      ...Object.keys(theme.fileExtensions).map(
        (extension) => `file.${extension}`
      ),
    ];
    for (const name of names) {
      const icons = fileIcons(name);
      expect(icons.dark.character, name).toHaveLength(1);
      expect(icons.dark.character.codePointAt(0), name).toBeGreaterThanOrEqual(
        0xe000
      );
      expect(icons.light.character, name).toBe(icons.dark.character);
    }
    expect(fileIcons("package.json").light.color).not.toBe(
      fileIcons("package.json").dark.color
    );
  });
});
