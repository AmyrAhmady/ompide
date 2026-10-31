// Real native file codecs, save/reopen UI, watchers and large Monaco buffers.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 30000 });
const directory = await mkdtemp(path.join(tmpdir(), "pawn-text-files-"));
const root = path.join(directory, "workspace");
const large = path.join(directory, "large.pwn");
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const previous = await readFile(preferences);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.waitForEvent("page"));
await page.waitForURL((url) => url.port === "1420", { timeout: 30000 });
page.setDefaultTimeout(30000);
const errors = [];
const evidence = [];
page.on("pageerror", (error) => errors.push(error.message));
const unicode = "// λ😀\r\nmain() { return 0; }\r\n";
const encoded = path.join(root, "unicode.pwn");
const legacy = path.join(root, "legacy.txt");
const scratch = path.join(root, "scratch.txt");
const dialog = () =>
  page.getByRole("dialog", { name: "File Encoding", exact: true });

async function evaluate(operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name);
      const { workbench } = await import(
        urls.find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url))
      );
      const { native } = await import(
        urls.find((url) => /\/src\/lib\/native\.ts(?:\?|$)/.test(url))
      );
      return await (0, eval)(operation)(workbench, native, argument);
    },
    { operation: operation.toString(), argument }
  );
}

const active = () =>
  evaluate((w) => {
    const state = w.getSnapshot();
    const document = Reflect.get(w, "documents").get(state.active);
    return {
      tab: state.tabs.find((tab) => tab.uri === state.active),
      length: document?.model.getValueLength(),
      language: document?.model.getLanguageId(),
      phase: state.languagePhase,
    };
  });

async function picker() {
  await page
    .locator(".statusbar button")
    .filter({ hasText: /UTF|windows|125|8859/ })
    .last()
    .click();
  await expect(dialog()).toBeVisible();
}

async function discardAll() {
  await evaluate(async (w) => {
    const unsubscribe = w.subscribe(() => {
      if (w.getSnapshot().prompt) w.answerPrompt("discard");
    });
    try {
      await w.closeAll();
    } finally {
      unsubscribe();
    }
  });
}

try {
  await mkdir(root);
  await writeFile(
    encoded,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(unicode, "utf16le")])
  );
  await writeFile(legacy, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await writeFile(scratch, "scratch");
  await writeFile(
    path.join(root, "pawn.json"),
    JSON.stringify({ entry: "unicode.pwn", preset: "openmp" })
  );
  const source = "// ".padEnd(83, "x") + "\r\n";
  await writeFile(large, source.repeat(160000));
  const seed = JSON.parse(previous.toString());
  seed.recentWorkspaces = [root];
  seed.recentFiles = [large];
  seed.settings = { ...seed.settings, formatOnSave: false };
  await writeFile(preferences, JSON.stringify(seed));
  await page.reload();
  await expect.poll(() => evaluate((w) => w.getSnapshot().ready)).toBe(true);
  await evaluate((w, _n, root) => w.chooseFolder(root), root);
  await evaluate((w, _n, file) => w.openPath(file), encoded);
  await expect.poll(async () => (await active()).tab.encoding).toBe("utf-16le");
  assert.equal(
    await evaluate((w) =>
      Reflect.get(w, "documents").get(w.getSnapshot().active).model.getValue()
    ),
    unicode
  );
  await expect
    .poll(() => evaluate((w) => w.getSnapshot().languagePhase))
    .toBe("ready");
  await expect
    .poll(() =>
      evaluate((w) =>
        w
          .documentSymbols("main")
          .then((symbols) =>
            symbols.some((symbol) => symbol.name.includes("main"))
          )
      )
    )
    .toBe(true);
  await picker();
  await dialog().getByLabel("Encoding", { exact: true }).selectOption("utf-8");
  await dialog()
    .getByRole("button", { name: "Save with Encoding", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  assert.equal(await readFile(encoded, "utf8"), unicode);
  assert.equal((await active()).tab.encoding, "utf-8");
  evidence.push(
    "UTF-16 BOM detection, Unicode/CRLF opening, real pawnlsp startup and conversion to UTF-8 pass."
  );

  const saved = await readFile(encoded);
  await evaluate((w) =>
    Reflect.get(w, "documents")
      .get(w.getSnapshot().active)
      .model.setValue("// unsaved 😀\r\nmain() {}")
  );
  await picker();
  await dialog()
    .getByLabel("Encoding", { exact: true })
    .selectOption("windows-1252");
  await dialog()
    .getByRole("button", { name: "Save with Encoding", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "cannot represent every character"
  );
  assert.deepEqual(await readFile(encoded), saved);
  assert.equal((await active()).tab.dirty, true);
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await picker();
  await dialog()
    .getByLabel("Encoding", { exact: true })
    .selectOption("utf-8-bom");
  await dialog()
    .getByRole("button", { name: "Save with Encoding", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  assert.deepEqual(
    (await readFile(encoded)).subarray(0, 3),
    Buffer.from([0xef, 0xbb, 0xbf])
  );
  evidence.push(
    "Unrepresentable edits never change disk or clear dirty state; UTF-8 BOM conversion succeeds."
  );

  await evaluate((w, _n, file) => w.openPath(file), legacy);
  await picker();
  await dialog()
    .getByLabel("Encoding", { exact: true })
    .selectOption("windows-1252");
  await dialog()
    .getByRole("button", { name: "Reopen with Encoding", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  await evaluate((w) =>
    Reflect.get(w, "documents")
      .get(w.getSnapshot().active)
      .model.setValue("keep unsaved text")
  );
  await picker();
  await dialog()
    .getByLabel("Encoding", { exact: true })
    .selectOption("windows-1251");
  await dialog()
    .getByRole("button", { name: "Reopen with Encoding", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(2);
  await page
    .locator("dialog[open]")
    .filter({ hasText: "Save changes" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(
    await evaluate((w) =>
      Reflect.get(w, "documents").get(w.getSnapshot().active).model.getValue()
    ),
    "keep unsaved text"
  );
  await dialog()
    .getByRole("button", { name: "Reopen with Encoding", exact: true })
    .click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  assert.equal((await active()).tab.encoding, "windows-1251");
  await writeFile(legacy, Buffer.from([0x63, 0x61, 0x66, 0xe0]));
  await expect
    .poll(() =>
      evaluate((w) =>
        Reflect.get(w, "documents").get(w.getSnapshot().active).model.getValue()
      )
    )
    .toBe("cafа");
  assert.equal((await active()).tab.encoding, "windows-1251");
  evidence.push(
    "Reopen Cancel retains unsaved text; Discard reopens explicitly, and file watching preserves the chosen legacy encoding."
  );

  const choices = await page.evaluate(
    async () => (await import("/src/editor/text-files.ts")).encodingChoices
  );
  for (const choice of choices) {
    const result = await evaluate(
      async (_w, n, { file, choice }) => {
        const before = await n.read(file);
        const saved = await n.save(
          file,
          "main() {}\r\n",
          choice.bom,
          before.revision,
          choice.encoding
        );
        return (await n.read(file, saved.encoding)).text;
      },
      { file: scratch, choice }
    );
    assert.equal(result, "main() {}\r\n", choice.id);
  }
  evidence.push(
    `All ${choices.length} encoding choices round-trip through actual native IPC.`
  );
  if (process.argv.includes("--native-dialogs")) {
    const explicit = path.join(root, "explicit-open.pwn");
    await writeFile(
      explicit,
      Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0d, 0x0a])
    );
    await page
      .locator(".menu summary")
      .getByText("File", { exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Open File with Encoding…", exact: true })
      .click();
    await dialog()
      .getByLabel("Encoding", { exact: true })
      .selectOption("windows-1252");
    await dialog()
      .getByRole("button", { name: "Open File", exact: true })
      .click();
    console.log(`Select this fixture in the native Open dialog: ${explicit}`);
    await expect(dialog()).toHaveCount(0, { timeout: 180000 });
    assert.equal((await active()).tab.encoding, "windows-1252");
    assert.equal(
      await evaluate((w) =>
        Reflect.get(w, "documents").get(w.getSnapshot().active).model.getValue()
      ),
      "// é\r\n"
    );
    const copy = path.join(root, "encoded-copy.pwn");
    const saving = evaluate((w) => w.save(undefined, true));
    void saving.catch(() => undefined);
    console.log(
      `Select this new filename in the native Save As dialog: ${copy}`
    );
    await expect
      .poll(
        async () =>
          readFile(copy).then(
            () => true,
            () => false
          ),
        { timeout: 180000 }
      )
      .toBe(true);
    await saving;
    assert.deepEqual(await readFile(copy), await readFile(explicit));
    assert.equal((await active()).tab.encoding, "windows-1252");
    evidence.push(
      "Open File with Encoding and Save As retain the chosen codec through actual native Windows file dialogs."
    );
  }
  await picker();
  for (const theme of ["dark", "light"]) {
    await evaluate((w, _n, theme) => w.settings({ theme }), theme);
    await page.screenshot({ path: `test-results/encoding-${theme}.png` });
  }
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await discardAll();

  const start = Date.now();
  await evaluate((w, _n, file) => w.recentFile(file), large);
  const openedIn = Date.now() - start;
  assert.equal((await active()).tab.largeFile, true);
  assert.equal((await active()).language, "plaintext");
  assert.equal((await active()).phase, "stopped");
  await expect(page.getByText(/^Large file mode:/)).toBeVisible();
  await evaluate((w) => w.focusEditor());
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// LARGE_EDIT_OK", { delay: 3 });
  assert.equal((await active()).tab.dirty, true);
  await evaluate((w) => w.save());
  assert.ok((await readFile(large, "utf8")).endsWith("// LARGE_EDIT_OK"));
  assert.equal((await active()).tab.dirty, false);
  await page.screenshot({ path: "test-results/large-file.png" });
  const oversized = path.join(root, "oversized.pwn");
  const handle = await open(oversized, "w");
  await handle.truncate(128 * 1024 * 1024 + 1);
  await handle.close();
  const error = await evaluate(async (_w, n, file) => {
    try {
      await n.read(file);
      return null;
    } catch (error) {
      return error.code;
    }
  }, oversized);
  assert.equal(error, "fileTooLarge");
  evidence.push(
    `A 13.6 MB Pawn file opens in ${openedIn} ms, uses plaintext without LSP, accepts keyboard edits and saves. Native oversized-file rejection remains bounded.`
  );
  assert.deepEqual(errors, []);
  console.log(evidence.join("\n"));
} catch (error) {
  await page
    .screenshot({ path: "test-results/text-files-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  try {
    const closed = page.waitForEvent("close", { timeout: 30000 });
    await discardAll();
    await evaluate(async (w) => {
      await Reflect.get(w, "settingsQueue");
      await w.quit();
    });
    await closed;
  } finally {
    await writeFile(preferences, previous);
    await browser.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pawn-text-files-"));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
