// Real desktop/real PawnKit language workflows, including closed-file edits and recovery.
import { chromium, expect } from "@playwright/test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pins = JSON.parse(
  await readFile(path.join(root, "toolchain/tools.json"), "utf8")
);
const lspVersion = pins.tools.find((tool) => tool.name === "pawnlsp").version;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
  context.pages().find((page) => page.url().includes(":1420/")) ??
  context.pages()[0] ??
  (await context.waitForEvent("page", { timeout: 30_000 }));
await page.waitForURL((url) => url.port === "1420", {
  timeout: 30_000,
  waitUntil: "domcontentloaded",
});
page.setDefaultTimeout(20_000);
const directory = await mkdtemp(path.join(tmpdir(), "pawn language "));
const minimal = path.join(directory, "minimal");
const openmp = path.join(directory, "openmp");
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const errors = [];
let expectedFailure = false;
let previous;
let seeded = false;
const evidence = {};
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !expectedFailure)
    errors.push(`${message.text()} ${JSON.stringify(message.location())}`);
});
page.on("response", (response) => {
  if (response.status() === 404)
    console.error("Missing asset:", response.url());
});
try {
  await readFile(
    path.join(root, "fixtures/openmp/.vendor/omp-stdlib/open.mp.inc")
  );
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(path.join(root, "fixtures/minimal"), minimal, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  await cp(path.join(root, "fixtures/openmp"), openmp, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [minimal, openmp],
      recentFiles: [],
      settings: {},
    })
  );
  await page.reload();
  await page.getByRole("button", { name: minimal, exact: true }).click();
  await expect(
    page.getByText("Pawn language server connected", { exact: true })
  ).toBeVisible();
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toBeVisible();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .reverse()
      .find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    globalThis.languageWorkbench = (await import(url)).workbench;
  });
  const responses = await page.evaluate(async () => {
    const workbench = globalThis.languageWorkbench;
    const client = Reflect.get(workbench, "language").client;
    const model = Reflect.get(workbench, "documents").get(
      workbench.getSnapshot().active
    ).model;
    const textDocument = {
      uri: client.code2ProtocolConverter.asUri(model.uri),
    };
    const position = { line: 4, character: 18 };
    const [hover, signature, references, symbols, folds, workspaceSymbols] =
      await Promise.all([
        client.sendRequest("textDocument/hover", { textDocument, position }),
        client.sendRequest("textDocument/signatureHelp", {
          textDocument,
          position: { line: 4, character: 24 },
        }),
        client.sendRequest("textDocument/references", {
          textDocument,
          position,
          context: { includeDeclaration: true },
        }),
        client.sendRequest("textDocument/documentSymbol", { textDocument }),
        client.sendRequest("textDocument/foldingRange", { textDocument }),
        client.sendRequest("workspace/symbol", { query: "" }),
      ]);
    return {
      hover,
      signature,
      references,
      symbols,
      folds,
      workspaceSymbols,
      tool: Reflect.get(workbench, "language").tool,
    };
  });
  expect(JSON.stringify(responses.hover)).toContain("Add");
  expect(responses.signature.signatures.length).toBeGreaterThan(0);
  expect(
    responses.references.some((location) => location.uri.endsWith("math.inc"))
  ).toBe(true);
  expect(
    responses.references.some((location) => location.uri.endsWith("main.pwn"))
  ).toBe(true);
  expect(responses.symbols.some((symbol) => symbol.name === "main")).toBe(true);
  expect(responses.folds.length).toBeGreaterThan(0);
  expect(responses.tool).toMatchObject({
    source: "bundled",
    version: lspVersion,
  });
  evidence.providers = responses;
  expect(
    responses.workspaceSymbols.some((symbol) => symbol.name === "main")
  ).toBe(true);
  expect(
    responses.workspaceSymbols.some(
      (symbol) =>
        symbol.name === "Add" && symbol.location.uri.endsWith("math.inc")
    )
  ).toBe(true);
  await page.evaluate(() =>
    globalThis.languageWorkbench.openUri(
      globalThis.languageWorkbench.getSnapshot().active,
      5,
      19
    )
  );
  await page.evaluate(() =>
    globalThis.languageWorkbench.action("editor.action.showHover")
  );
  await expect(
    page.locator(".monaco-hover").filter({ hasText: "Add" }).first()
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    globalThis.languageWorkbench.openUri(
      globalThis.languageWorkbench.getSnapshot().active,
      5,
      25
    )
  );
  await page.evaluate(() =>
    globalThis.languageWorkbench.action("editor.action.triggerParameterHints")
  );
  await expect(page.locator(".parameter-hints-widget.visible")).toContainText(
    "Add"
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    globalThis.languageWorkbench.openUri(
      globalThis.languageWorkbench.getSnapshot().active,
      5,
      19
    )
  );
  await page.keyboard.press("Shift+F12");
  await expect(page.locator(".statusbar")).toContainText("Ln 5, Col 18");
  await page.evaluate(() =>
    globalThis.languageWorkbench.action("editor.action.referenceSearch.trigger")
  );
  await expect(page.locator(".peekview-widget")).toContainText("main.pwn");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+o");
  await page
    .getByRole("combobox", { name: "Search symbols in this file", exact: true })
    .fill("main");
  await expect(
    page.getByRole("option").filter({ hasText: "main" }).first()
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+t");
  await page
    .getByRole("combobox", { name: "Search workspace symbols", exact: true })
    .fill("main");
  await expect(
    page.getByRole("option").filter({ hasText: "main" }).first()
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // math.inc has never been opened. Rename must open/track it and leave both buffers dirty.
  await page.evaluate(() =>
    globalThis.languageWorkbench.openUri(
      globalThis.languageWorkbench.getSnapshot().active,
      5,
      20
    )
  );
  await page.keyboard.press("F2");
  await page.locator(".rename-box input").fill("SumPair");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tab", { name: "math.inc", exact: true })
  ).toBeVisible();
  await expect(page.locator(".tab .dirty")).toHaveCount(2);
  expect(await readFile(path.join(minimal, "math.inc"), "utf8")).toContain(
    "stock Add("
  );
  await page.keyboard.press("Control+Alt+s");
  await expect(page.locator(".tab .dirty")).toHaveCount(0);
  expect(await readFile(path.join(minimal, "math.inc"), "utf8")).toContain(
    "stock SumPair("
  );
  expect(await readFile(path.join(minimal, "main.pwn"), "utf8")).toContain(
    "SumPair(1, 2)"
  );
  await page
    .getByRole("button", { name: "Close math.inc", exact: true })
    .click();
  await page.evaluate(() =>
    globalThis.languageWorkbench.openUri(
      globalThis.languageWorkbench.getSnapshot().active,
      5,
      20
    )
  );
  await page.keyboard.press("F2");
  await page.locator(".rename-box input").fill("SumAgain");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tab", { name: "math.inc", exact: true })
  ).toBeVisible();
  await expect(page.locator(".tab .dirty")).toHaveCount(2);
  await page.keyboard.press("Control+Alt+s");
  await expect(page.locator(".tab .dirty")).toHaveCount(0);
  expect(await readFile(path.join(minimal, "math.inc"), "utf8")).toContain(
    "stock SumAgain("
  );
  await page.evaluate(async () => {
    const workbench = globalThis.languageWorkbench;
    await workbench.settings({ formatOnSave: true });
    for (const document of Reflect.get(workbench, "documents").values())
      document.model.setValue(
        document.name === "main.pwn"
          ? '#include "math.inc"\nmain(){return SumPair(1,2);}\n'
          : "stock SumPair(left,right){return left+right;}\n"
      );
  });
  await page.getByRole("tab", { name: "main.pwn", exact: true }).click();
  await page.keyboard.press("Control+Alt+s");
  await expect(page.locator(".tab .dirty")).toHaveCount(0);
  expect(await readFile(path.join(minimal, "main.pwn"), "utf8")).toContain(
    "SumPair(1, 2)"
  );
  expect(await readFile(path.join(minimal, "math.inc"), "utf8")).toContain(
    "return left + right;"
  );
  await page.evaluate(() => {
    const workbench = globalThis.languageWorkbench;
    Reflect.get(workbench, "documents")
      .get(workbench.getSnapshot().active)
      .model.setValue("main() { if (true); { return; } }\n");
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          globalThis.languageWorkbench
            .getSnapshot()
            .problems.some(
              (problem) =>
                problem.message.includes("empty") ||
                String(problem.code?.value).includes("empty-condition-body")
            )
        ),
      { timeout: 20_000 }
    )
    .toBe(true);
  await page.evaluate(() =>
    globalThis.languageWorkbench.openUri(
      globalThis.languageWorkbench.getSnapshot().active,
      1,
      19
    )
  );
  await page.keyboard.press("Control+Period");
  await page
    .getByText(/remove the stray semicolon/)
    .first()
    .click();
  expect(
    await page.evaluate(() => {
      const workbench = globalThis.languageWorkbench;
      return Reflect.get(workbench, "documents")
        .get(workbench.getSnapshot().active)
        .model.getValue();
    })
  ).not.toContain("if (true);");
  // Kill only this test application's owned pawnlsp, then verify a new session keeps the dirty model.
  await page.evaluate(() => {
    const workbench = globalThis.languageWorkbench;
    const model = Reflect.get(workbench, "documents").get(
      workbench.getSnapshot().active
    ).model;
    model.setValue(model.getValue() + "// preserve recovery 🦀\n");
    globalThis.languageBeforeCrash = Reflect.get(workbench, "language");
  });
  expectedFailure = true;
  const killed = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$app = @(Get-CimInstance Win32_Process -Filter \"Name = 'omp-pawn-editor.exe'\" | Where-Object { $_.ExecutablePath -eq $env:PAWN_IDE_TEST_EXECUTABLE }); if ($app.Count -ne 1) { throw 'Expected one test app' }; $child = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app[0].ProcessId -and $_.Name -like 'pawnlsp*.exe' }); if ($child.Count -ne 1) { throw 'Expected one owned language server' }; Stop-Process -Id $child[0].ProcessId; $child[0].ProcessId",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        PAWN_IDE_TEST_EXECUTABLE: path.join(
          root,
          "src-tauri/target/debug/omp-pawn-editor.exe"
        ),
      },
    }
  );
  if (killed.status !== 0) throw new Error(killed.stderr);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const workbench = globalThis.languageWorkbench;
          return (
            Reflect.get(workbench, "language") !==
              globalThis.languageBeforeCrash &&
            workbench.getSnapshot().languagePhase === "ready"
          );
        }),
      { timeout: 20_000 }
    )
    .toBe(true);
  expectedFailure = false;
  expect(
    await page.evaluate(() => {
      const workbench = globalThis.languageWorkbench;
      return Reflect.get(workbench, "documents")
        .get(workbench.getSnapshot().active)
        .model.getValue();
    })
  ).toContain("preserve recovery 🦀");
  await page.keyboard.press("Control+Alt+s");
  await expect(page.locator(".tab .dirty")).toHaveCount(0);
  const external = path.join(directory, "external-pawnlsp.exe");
  await copyFile(
    path.join(root, "src-tauri/binaries/pawnlsp-x86_64-pc-windows-msvc.exe"),
    external
  );
  await page.evaluate(async (external) => {
    await globalThis.languageWorkbench.settings({
      languageServerPath: external,
    });
    await globalThis.languageWorkbench.restartLanguage();
  }, external);
  expect(
    await page.evaluate(
      () => Reflect.get(globalThis.languageWorkbench, "language").tool.source
    )
  ).toBe("external");
  expectedFailure = true;
  await page.evaluate(async (invalid) => {
    await globalThis.languageWorkbench.settings({
      languageServerPath: invalid,
    });
    await globalThis.languageWorkbench.restartLanguage();
  }, process.execPath);
  await expect(page.locator(".error-banner")).toContainText(
    `Expected pawnlsp ${lspVersion}, but the executable reports ${process.version}`
  );
  expect(
    await page.evaluate(
      () => globalThis.languageWorkbench.getSnapshot().languagePhase
    )
  ).toBe("stopped");
  await page.evaluate(
    async (missing) => {
      await globalThis.languageWorkbench.settings({
        languageServerPath: missing,
      });
      await globalThis.languageWorkbench.restartLanguage();
    },
    path.join(directory, "missing-pawnlsp.exe")
  );
  await expect(page.locator(".error-banner")).toContainText(
    "The file or folder no longer exists."
  );
  expect(
    await page.evaluate(
      () => globalThis.languageWorkbench.getSnapshot().languagePhase
    )
  ).toBe("stopped");
  await page.evaluate(async () => {
    await globalThis.languageWorkbench.settings({ languageServerPath: "" });
  });
  await page
    .getByRole("button", { name: "Restart Language Server", exact: true })
    .click();
  expectedFailure = false;
  await expect(
    page.getByText("Pawn language server connected", { exact: true })
  ).toBeVisible();
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await page.evaluate(
    (openmp) => globalThis.languageWorkbench.chooseFolder(openmp),
    openmp
  );
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toBeVisible();
  evidence.openmp = await page.evaluate(async () => {
    const workbench = globalThis.languageWorkbench;
    const client = Reflect.get(workbench, "language").client;
    const model = Reflect.get(workbench, "documents").get(
      workbench.getSnapshot().active
    ).model;
    const text = model.getValue();
    const at = (word) => {
      const position = model.getPositionAt(text.indexOf(word) + 3);
      return { line: position.lineNumber - 1, character: position.column - 1 };
    };
    const textDocument = {
      uri: client.code2ProtocolConverter.asUri(model.uri),
    };
    return {
      native: await client.sendRequest("textDocument/definition", {
        textDocument,
        position: at("SetPlayerPos"),
      }),
      helper: await client.sendRequest("textDocument/definition", {
        textDocument,
        position: at("WelcomePlayer"),
      }),
      macro: await client.sendRequest("textDocument/hover", {
        textDocument,
        position: at("SPAWN_X"),
      }),
      completions: await client.sendRequest("textDocument/completion", {
        textDocument,
        position: at("SetPlayerPos"),
      }),
    };
  });
  expect(JSON.stringify(evidence.openmp.native)).toContain("omp_player.inc");
  expect(JSON.stringify(evidence.openmp.helper)).toContain("gameplay.inc");
  expect(JSON.stringify(evidence.openmp.macro)).toContain("SPAWN_X");
  expect(
    (evidence.openmp.completions.items ?? evidence.openmp.completions).some(
      (item) => item.label === "SetPlayerPos"
    )
  ).toBe(true);
  const mainUri = await page.evaluate(
    () => globalThis.languageWorkbench.getSnapshot().active
  );
  await page.evaluate(
    async (config) => {
      const workbench = globalThis.languageWorkbench;
      await workbench.openPath(config);
      const model = Reflect.get(workbench, "documents").get(
        workbench.getSnapshot().active
      ).model;
      model.setValue(model.getValue().replace("1958.3783", "2001.25"));
    },
    path.join(openmp, "include/config.inc")
  );
  await page.evaluate(
    (mainUri) => globalThis.languageWorkbench.openUri(mainUri),
    mainUri
  );
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const workbench = globalThis.languageWorkbench;
          const client = Reflect.get(workbench, "language").client;
          const model = Reflect.get(workbench, "documents").get(
            workbench.getSnapshot().active
          ).model;
          const position = model.getPositionAt(
            model.getValue().indexOf("SPAWN_X") + 3
          );
          return JSON.stringify(
            await client.sendRequest("textDocument/hover", {
              textDocument: {
                uri: client.code2ProtocolConverter.asUri(model.uri),
              },
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            })
          );
        }),
      { timeout: 20_000 }
    )
    .toContain("2001.25");
  expect(
    await readFile(path.join(openmp, "include/config.inc"), "utf8")
  ).toContain("1958.3783");
  const started = Date.now();
  await page
    .locator(".monaco-editor.standalone")
    .click({ position: { x: 250, y: 100 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// real open.mp typing response\n");
  evidence.typingMilliseconds = Date.now() - started;
  expect(evidence.typingMilliseconds).toBeLessThan(3000);
  await page.keyboard.press("Control+Alt+s");
  await expect(page.locator(".tab .dirty")).toHaveCount(0);
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/language-workflows.json"),
    JSON.stringify(evidence, null, 2)
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Real language workflows: hover/signature/references/symbols/folding, unopened-file rename, all-document formatting, Quick Fix, crash recovery, tool selection/rejection, and official open.mp includes/macros passed"
  );
} catch (error) {
  console.error("Language verification failed:", error);
  console.error("Unexpected browser errors:", errors);
  console.error("UI:", (await page.locator("body").innerText()).slice(0, 2000));
  throw error;
} finally {
  try {
    // Close the test-owned application so pending native operations cannot retain fixture handles.
    expectedFailure = true;
    const closed = page.waitForEvent("close");
    await page.evaluate(async () => {
      const workbench = globalThis.languageWorkbench;
      if (workbench) {
        await Reflect.get(workbench, "settingsQueue");
        workbench.subscribe(() => {
          if (workbench.getSnapshot().prompt) workbench.answerPrompt("discard");
        });
        await workbench.quit();
      }
    });
    await closed;
  } finally {
    if (seeded) {
      if (previous) await writeFile(preferences, previous);
      else await rm(preferences, { force: true });
    }
    await browser.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
