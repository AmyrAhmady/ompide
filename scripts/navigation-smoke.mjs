// Attach to the existing debug app + Vite; no native rebuild or mocked IPC.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectRoot, removeTemporary } from "./release-support.mjs";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => new URL(page.url()).port === "1420");
if (!page) {
  await browser.close();
  throw new Error(
    "Start the debug desktop app with Vite and loopback CDP first"
  );
}
page.setDefaultTimeout(15_000);
const directory = await mkdtemp(path.join(tmpdir(), "ompide-nav-"));
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const previous = await readFile(preferences).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return undefined;
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const cdp = await browser.contexts()[0].newCDPSession(page);

async function evaluate(operation, argument) {
  return page.evaluate(
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
}

async function active(uri, line, column) {
  await expect
    .poll(() =>
      evaluate((workbench) => ({
        uri: workbench.getSnapshot().active,
        ...workbench.getSnapshot().position,
      }))
    )
    .toEqual({ uri, line, column });
}

async function mouse(button) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button,
    buttons: button === "back" ? 8 : 16,
    x: 700,
    y: 250,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button,
    buttons: 0,
    x: 700,
    y: 250,
    clickCount: 1,
  });
}

async function exit() {
  await page
    .locator(".menu summary")
    .getByText("File", { exact: true })
    .click();
  const closed = page.waitForEvent("close");
  await page.getByRole("menuitem", { name: "Exit", exact: true }).click();
  await closed;
}

try {
  await cp(path.join(projectRoot, "fixtures/minimal"), directory, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  const main = path.join(directory, "main.pwn");
  const source = await readFile(main, "utf8");
  const add = source.indexOf("Add(1");
  const before = source.slice(0, add + 1).split("\n");
  const position = { line: before.length, column: before.at(-1).length + 1 };
  await writeFile(
    path.join(directory, "notes.txt"),
    Array.from(
      { length: 120 },
      (_, index) => `Line ${index + 1} contents`
    ).join("\n")
  );
  await mkdir(path.dirname(preferences), { recursive: true });
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [directory],
      recentFiles: [],
      settings: { theme: "dark" },
    })
  );
  await page.reload();
  await page.getByRole("button", { name: directory, exact: true }).click();
  await expect(
    page.getByText("Pawn language server connected", { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toBeVisible();
  const mainUri = await evaluate((workbench) => workbench.getSnapshot().active);
  await evaluate(
    (workbench, { uri, line, column }) => workbench.openUri(uri, line, column),
    { uri: mainUri, ...position }
  );
  await page.keyboard.press("F12");
  await expect(
    page.getByRole("tab", { name: "math.inc", exact: true })
  ).toBeVisible();
  await expect
    .poll(() =>
      evaluate((workbench) => Reflect.get(workbench, "navigationMuted"))
    )
    .toBe(0);
  const definition = await evaluate((workbench) => ({
    uri: workbench.getSnapshot().active,
    ...workbench.getSnapshot().position,
  }));
  assert.notEqual(definition.uri, mainUri);
  await mouse("back");
  await active(mainUri, position.line, position.column);
  await mouse("forward");
  await active(definition.uri, definition.line, definition.column);
  await page.keyboard.press("Alt+ArrowLeft");
  await active(mainUri, position.line, position.column);
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// navigation keeps unsaved text\n");
  const editedPosition = await evaluate(
    (workbench) => workbench.getSnapshot().position
  );
  await mouse("forward");
  await active(definition.uri, definition.line, definition.column);
  await mouse("back");
  await active(mainUri, editedPosition.line, editedPosition.column);
  await expect(page.locator(".tab.active .dirty")).toBeVisible();

  await evaluate(
    (workbench, file) => workbench.openPath(file),
    path.join(directory, "notes.txt")
  );
  const notes = await evaluate((workbench) => workbench.getSnapshot().active);
  for (const [line, column] of [
    [20, 3],
    [90, 6],
  ])
    await evaluate(
      (workbench, { uri, line, column }) =>
        workbench.openUri(uri, line, column),
      { uri: notes, line, column }
    );
  await mouse("back");
  await active(notes, 20, 3);
  await evaluate((workbench, uri) => workbench.openUri(uri, 90, 6), notes);
  await evaluate((workbench) =>
    Promise.all([workbench.navigate(-1), workbench.navigate(-1)])
  );
  await active(notes, 1, 1);
  await page.keyboard.press("Alt+ArrowRight");
  await active(notes, 20, 3);
  await page.keyboard.press("Alt+ArrowLeft");
  await active(notes, 1, 1);
  await page.keyboard.press("Alt+ArrowRight");
  await active(notes, 20, 3);
  await evaluate((workbench, uri) => workbench.openUri(uri, 50, 4), notes);
  assert.equal(
    await evaluate((workbench) => workbench.getSnapshot().canGoForward),
    false
  );
  await page
    .getByRole("tab", { name: "notes.txt", exact: true })
    .click({ button: "middle" });
  await expect(
    page.getByRole("tab", { name: "notes.txt", exact: true })
  ).toHaveCount(0);
  await mouse("back");
  await active(notes, 50, 4);
  await page
    .getByRole("tab", { name: "math.inc", exact: true })
    .click({ button: "middle" });
  await expect(
    page.getByRole("tab", { name: "math.inc", exact: true })
  ).toHaveCount(0);
  await active(notes, 50, 4);

  await page
    .getByRole("tab", { name: "main.pwn", exact: true })
    .click({ button: "middle" });
  const prompt = page.getByRole("dialog");
  await expect(prompt).toBeVisible();
  const promptActive = await evaluate(
    (workbench) => workbench.getSnapshot().active
  );
  await mouse("back");
  assert.equal(
    await evaluate((workbench) => workbench.getSnapshot().active),
    promptActive
  );
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toBeVisible();
  await expect(page.locator(".tab .dirty")).toHaveCount(1);
  await page
    .getByRole("tab", { name: "main.pwn", exact: true })
    .click({ button: "middle" });
  await prompt.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toHaveCount(0);
  assert.match(await readFile(main, "utf8"), /navigation keeps unsaved text/);
  await evaluate(async (workbench) => {
    await workbench.newFile();
    Reflect.get(workbench, "codeEditor").trigger("keyboard", "type", {
      text: "unsaved",
    });
  });
  await page.locator(".tab.active [role=tab]").click({ button: "middle" });
  await prompt.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Untitled/ })).toHaveCount(0);

  for (
    let count = 0;
    await evaluate((workbench) => workbench.getSnapshot().canGoBack);
    count++
  ) {
    assert.ok(
      count < 30,
      "Back must eventually reach the beginning of the trail"
    );
    await evaluate((workbench) => workbench.navigate(-1));
  }
  await page.evaluate(() =>
    globalThis.history.pushState(null, "", "?mouse-history-check")
  );
  const url = page.url();
  await mouse("back");
  assert.equal(page.url(), url);
  await evaluate((workbench) =>
    workbench.chooseFolder(workbench.getSnapshot().root)
  );
  assert.deepEqual(
    await evaluate((workbench) => [
      workbench.getSnapshot().canGoBack,
      workbench.getSnapshot().canGoForward,
    ]),
    [false, false]
  );
  assert.deepEqual(errors, []);
  console.log(
    "Native navigation passed: real F12, mouse back/forward, Alt+arrows, same-file jumps, dirty-buffer retention, branching, closed-file reopening, background/active middle-close, Cancel/Save/Discard, modal/browser-history protection and workspace reset."
  );
} catch (error) {
  if (!page.isClosed())
    console.error((await page.locator("body").innerText()).slice(0, 2500));
  throw error;
} finally {
  try {
    if (!page.isClosed()) {
      await page.reload(); // Only disposable fixtures are open; clear any failed test's edits.
      await exit();
    }
  } finally {
    if (previous) await writeFile(preferences, previous);
    else await rm(preferences, { force: true });
    await browser.close();
    await removeTemporary(directory, tmpdir(), "ompide-nav-");
  }
}
