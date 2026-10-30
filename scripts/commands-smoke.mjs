// Uses real Tauri file operations, Monaco actions and persisted preferences.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 15_000 });
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "pawn-command-smoke-"));
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().includes("1420"));
if (!page)
  throw new Error(
    "Start the native debug app connected to Vite with loopback CDP port 9222."
  );
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
const evidence = [];
let previous;
let seeded = false;

async function evaluate(operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const source = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
      const { workbench } = await import(source);
      return await (0, eval)(operation)(workbench, argument);
    },
    { operation: operation.toString(), argument }
  );
}

const palette = () =>
  page.getByRole("dialog", { name: "Command Palette…", exact: true });

async function find(query, shortcut = "Control+Shift+p") {
  await page.keyboard.press(shortcut);
  await expect(palette()).toBeVisible();
  await palette()
    .getByRole("combobox", { name: "Search commands", exact: true })
    .fill(query);
}

async function enter() {
  await palette().getByRole("combobox").press("Enter");
  await expect(palette()).toHaveCount(0);
}

try {
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(path.join(root, "fixtures/minimal"), directory, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [directory],
      settings: { theme: "dark" },
    })
  );
  await page.reload();
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Restart Language Server", exact: true })
  ).toHaveCount(0);
  await find("build project", "F1");
  await expect(palette().getByRole("option")).toHaveAttribute(
    "aria-disabled",
    "true"
  );
  await palette().getByRole("combobox").press("Enter");
  await expect(palette()).toBeVisible();
  assert.equal(
    await evaluate((workbench) => workbench.getSnapshot().build.phase),
    "idle"
  );
  await page.keyboard.press("Escape");
  evidence.push(
    "F1 opens the searchable palette; unavailable commands are identified and cannot execute without a workspace."
  );
  await find("reopen closed");
  await expect(palette().getByRole("option")).toHaveAttribute(
    "aria-disabled",
    "true"
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: directory, exact: true }).click();
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  const main = path.join(directory, "main.pwn");
  const original = await readFile(main);
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("// saved from command palette\n");
  assert.deepEqual(await readFile(main), original);
  await find("all save");
  await expect(palette().getByRole("option")).toHaveCount(1);
  await enter();
  await expect
    .poll(() => readFile(main, "utf8"))
    .toContain("saved from command palette");
  await expect
    .poll(() =>
      evaluate((workbench) =>
        workbench.getSnapshot().tabs.some((tab) => tab.dirty)
      )
    )
    .toBe(false);
  await expect(
    page.getByRole("textbox", { name: "Pawn IDE", exact: true })
  ).toBeFocused();
  evidence.push(
    "Ctrl+Shift+P searches by unordered words and executes real Save All against a dirty editor and disk."
  );

  await find("not a real command");
  await expect(palette().getByRole("status")).toHaveText(
    "No matching commands."
  );
  await palette().getByRole("combobox").press("Enter");
  await expect(palette()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Pawn IDE", exact: true })
  ).toBeFocused();
  evidence.push(
    "No-match and Escape behavior preserves the editor and restores typing focus."
  );

  await find("toggle");
  await palette().getByRole("combobox").press("Control+End");
  await expect(
    palette().getByRole("option", { name: "Toggle Word Wrap", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await enter();
  await expect
    .poll(() =>
      evaluate((workbench) => workbench.getSnapshot().settings.wordWrap)
    )
    .toBe(true);
  await expect
    .poll(() =>
      evaluate(
        (workbench) =>
          Reflect.get(workbench, "codeEditor").getRawOptions().wordWrap
      )
    )
    .toBe("on");
  await find("toggle minimap");
  await enter();
  await expect
    .poll(() =>
      evaluate(
        (workbench) =>
          Reflect.get(workbench, "codeEditor").getRawOptions().minimap.enabled
      )
    )
    .toBe(true);
  await expect(
    page.locator(".monaco-container .minimap").first()
  ).toBeVisible();
  evidence.push(
    "Keyboard selection executes actual word-wrap/minimap changes in Monaco."
  );
  await evaluate((workbench) => Reflect.get(workbench, "settingsQueue"));
  const stored = JSON.parse(await readFile(preferences, "utf8"));
  assert.equal(stored.settings.wordWrap, true);
  assert.equal(stored.settings.minimap, true);
  evidence.push("Word-wrap and minimap choices persist in native preferences.");

  await find("settings", "F1");
  await enter();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page
    .locator(".menu summary")
    .getByText("View", { exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Command Palette… Ctrl+Shift+P",
      exact: true,
    })
    .click();
  await palette().getByRole("combobox").fill("find");
  await enter();
  await expect(page.locator(".monaco-container .find-widget")).toHaveClass(
    /visible/
  );
  await page.keyboard.press("Escape");
  evidence.push(
    "Palette actions can open the real Settings dialog and Monaco Find widget after closing their own dialog; the View menu uses the shared command."
  );

  await page.keyboard.press("Control+p");
  const quick = page.getByRole("dialog", {
    name: "Open File by Name…",
    exact: true,
  });
  await expect(quick).toBeVisible();
  await page.keyboard.press("Escape");
  evidence.push(
    "Ctrl+P retains file search while Ctrl+Shift+P opens commands."
  );
  await page.keyboard.press("Control+n");
  await expect(
    page.getByRole("tab", { name: "Untitled-1", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await find("format document");
  await expect(palette().getByRole("option")).toHaveAttribute(
    "aria-disabled",
    "true"
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+w");
  await expect(
    page.getByRole("tab", { name: "Untitled-1", exact: true })
  ).toHaveCount(0);
  await page.getByRole("treeitem", { name: "pawn.json", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "pawn.json", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await find("format document");
  await expect(palette().getByRole("option")).toHaveAttribute(
    "aria-disabled",
    "true"
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+w");
  await expect(
    page.getByRole("tab", { name: "pawn.json", exact: true })
  ).toHaveCount(0);
  await find("reopen closed");
  await expect(palette().getByRole("option")).toHaveAttribute(
    "aria-disabled",
    "false"
  );
  await enter();
  await expect(
    page.getByRole("tab", { name: "pawn.json", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+w");
  await expect(
    page.getByRole("tab", { name: "pawn.json", exact: true })
  ).toHaveCount(0);
  evidence.push(
    "Pawn-only commands are unavailable for untitled/JSON buffers, and Reopen becomes available only after closing a real file."
  );
  for (const theme of ["light", "dark"]) {
    await evaluate((workbench, theme) => workbench.settings({ theme }), theme);
    await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(255, 255, 255)" : "rgb(30, 30, 30)"
    );
    await find("save");
    await mkdir(path.join(root, "test-results"), { recursive: true });
    await page.screenshot({
      path: path.join(root, `test-results/commands-${theme}.png`),
    });
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, "test-results/command-workflows.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  console.error("Command verification failed:", error);
  console.error("Browser errors:", errors);
  console.error("UI:", (await page.locator("body").innerText()).slice(-3500));
  throw error;
} finally {
  try {
    const closed = page.waitForEvent("close", { timeout: 20_000 });
    await evaluate(async (workbench) => {
      await Reflect.get(workbench, "settingsQueue");
      workbench.subscribe(() => {
        if (workbench.getSnapshot().prompt) workbench.answerPrompt("discard");
      });
      await workbench.quit();
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
