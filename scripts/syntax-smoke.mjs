// Check real TextMate rendering without native IPC or an installed language server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { projectRoot } from "./release-support.mjs";

const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "0"],
  { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
);
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Vite startup timed out: ${output}`)),
      30_000
    );
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-16_384);
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (address) {
        clearTimeout(timer);
        resolve(address);
      }
    };
    server.stdout.on("data", read);
    server.stderr.on("data", read);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited (${code}): ${output}`));
    });
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

  const evaluate = (operation, argument) =>
    page.evaluate(
      async ({ operation, argument }) => {
        const source = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
        const { workbench } = await import(source);
        return (0, eval)(operation)(workbench, argument);
      },
      { operation: operation.toString(), argument }
    );
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready), {
      timeout: 60_000,
    })
    .toBe(true);
  const lines = [
    "public OnGameModeInit() {}",
    "stock Float:Double(Float:value) { return value * 2.0; }",
    "new const MAX_COUNT = 10;",
    "static cached;",
    "native Print(const text[]);",
    "forward OnReady();",
    "enum PlayerState { READY, BUSY };",
    "new bool:enabled = true;",
    "#define MAX_COUNT 5",
    "// public stock new const",
    'new text[] = "public ^n";',
    'printf("Player %02d: %s", playerid, name);',
    "// TODO: check format fields",
    "/* FIXME: adjust limit */",
    "#define APPLY(%0) " + "\\",
    "    %0 = 1_000",
    "new recovered = 0xFF_FF;",
    "switch (value) { case 1..10: break; }",
    "#pragma tabsize 4",
    "#emit LOAD.pri 12",
    "#warning Configure include paths",
    'new broken[] = "unfinished',
    "new normal = 1;",
  ];
  await evaluate(async (workbench, source) => {
    await workbench.newFile();
    Reflect.get(workbench, "codeEditor").getModel().setValue(source);
  }, lines.join("\n"));
  const samples = [
    [0, "public", "storage"],
    [1, "stock", "storage"],
    [1, "Float", "entity.name.type"],
    [2, "new", "storage"],
    [2, "const", "storage"],
    [2, "MAX_COUNT", "constant.other"],
    [3, "static", "storage"],
    [4, "native", "storage"],
    [4, "const", "storage"],
    [5, "forward", "storage"],
    [6, "enum", "storage"],
    [6, "PlayerState", "entity.name.type"],
    [7, "true", "constant.language"],
    [8, "MAX_COUNT", "entity.name.constant"],
    [9, "public", "comment"],
    [10, "public", "string"],
    [10, "^n", "constant.character.escape"],
    [11, "%02d", "constant.other"],
    [11, "%s", "constant.other"],
    [12, "TODO", "keyword"],
    [12, "check", "comment"],
    [13, "FIXME", "keyword"],
    [14, "APPLY", "entity.name.function"],
    [14, "%0", "variable.parameter"],
    [15, "%0", "variable.parameter"],
    [15, "1_000", "constant.numeric"],
    [16, "new", "storage"],
    [16, "0xFF_FF", "constant.numeric"],
    [17, "..", "keyword"],
    [18, "tabsize", "keyword"],
    [19, "LOAD.pri", "entity.name.function"],
    [20, "Configure", "string"],
    [22, "new", "storage"],
  ];
  const dark = JSON.parse(
    await readFile(
      path.join(projectRoot, "src/settings/themes/dark.json"),
      "utf8"
    )
  );
  const light = JSON.parse(
    await readFile(
      path.join(projectRoot, "src/settings/themes/light.json"),
      "utf8"
    )
  );
  const rgb = (hex) =>
    `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
  const ocean = JSON.parse(
    await readFile(path.join(projectRoot, "examples/themes/ocean.json"), "utf8")
  );
  const custom = {
    ...ocean,
    name: "Storage override",
    tokenColors: [
      ...ocean.tokenColors,
      { scope: "storage", settings: { foreground: "#ff55aa" } },
    ],
  };
  for (const [name, base, customTheme] of [
    ["dark", dark],
    ["light", light],
    ["partial-custom", dark, ocean],
    ["storage-custom", dark, custom],
    ["dark-restored", dark],
  ]) {
    await evaluate(
      async (workbench, { base, customTheme }) => {
        const source = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => /\/src\/settings\/theme\.ts(?:\?|$)/.test(url));
        const { parseTheme } = await import(source);
        return workbench.settings({
          theme: customTheme ? "custom" : base,
          customTheme: customTheme ? parseTheme(customTheme) : null,
        });
      },
      { base: base.base, customTheme }
    );
    for (const [row, word, scope] of samples) {
      const rule =
        customTheme?.tokenColors.find((rule) => rule.scope === scope) ??
        base.tokenColors.find((rule) => rule.scope === scope);
      assert.ok(rule, `No expected color for ${name} ${scope}`);
      const offset = lines[row].indexOf(word);
      await expect
        .poll(
          () =>
            page
              .locator(".view-lines .view-line")
              .nth(row)
              .evaluate((line, offset) => {
                let start = 0;
                for (const span of line.querySelectorAll("span")) {
                  if (span.children.length) continue;
                  const length = span.textContent.length;
                  if (offset >= start && offset < start + length)
                    return globalThis.getComputedStyle(span).color;
                  start += length;
                }
                return undefined;
              }, offset),
          { message: `${name}: ${word} (${scope})`, timeout: 15_000 }
        )
        .toBe(rgb(rule.settings.foreground));
    }
    if (["dark", "light", "storage-custom"].includes(name)) {
      await mkdir(path.join(projectRoot, "test-results"), { recursive: true });
      await page.screenshot({
        path: path.join(projectRoot, `test-results/syntax-${name}.png`),
      });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Pawn syntax rendering passed: keywords, tags, constants, escapes, format placeholders, multiline macros, comment annotations, ranges/directives, unterminated-string recovery, Light/Dark, partial custom-theme inheritance and storage overrides/reset."
  );
} finally {
  await browser?.close();
  server.kill();
}
