// Measure real keyboard-to-frame latency with a large document and Explorer.
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 30_000 });
const root = fileURLToPath(new URL("../", import.meta.url));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
  context.pages().find((page) => page.url().includes(":1420/")) ??
  context.pages()[0] ??
  (await context.waitForEvent("page"));
await page.waitForURL((url) => url.port === "1420", {
  timeout: 30_000,
  waitUntil: "domcontentloaded",
});
page.setDefaultTimeout(30_000);
const directory = await mkdtemp(path.join(tmpdir(), "pawn-performance-smoke-"));
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const baseline = process.argv.includes("--baseline");
const profiling = process.argv.includes("--profile");
const profiler = profiling ? await context.newCDPSession(page) : undefined;
if (profiler) await profiler.send("Profiler.enable");
const errors = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
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

async function frames() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve)
        )
      )
  );
}

async function waitForClose(closed) {
  try {
    await closed;
  } catch (error) {
    if (!page.isClosed())
      console.error(
        "Close trace:",
        await evaluate((workbench) => ({
          trace: globalThis.pawnCloseTrace,
          phase: workbench.getSnapshot().languagePhase,
          closing: Reflect.get(workbench, "closingWindow"),
          tabs: workbench.getSnapshot().tabs,
          error: workbench.getSnapshot().error,
        }))
      );
    throw error;
  }
}

async function removeEmptyFixtureFolder() {
  try {
    await rmdir(directory);
  } catch (error) {
    // Windows can retain a directory handle after the WebView has closed.
    // Only tolerate that lock after every generated file has been removed.
    if (error.code !== "EBUSY" || (await readdir(directory)).length)
      throw error;
    console.warn(
      "Generated files removed; Windows retained the empty temporary folder:",
      directory
    );
  }
}

async function measure(name) {
  await evaluate((workbench) => {
    const editor = Reflect.get(workbench, "codeEditor");
    const model = editor.getModel();
    editor.setPosition(model.getPositionAt(model.getValueLength()));
    editor.focus();
  });
  await frames();
  if (profiler) await profiler.send("Profiler.start");
  await page.evaluate(() => {
    globalThis.pawnTypingFrames = [];
    globalThis.pawnRecordKey = (event) => {
      if (event.key.length !== 1) return;
      const start = performance.now();
      globalThis.requestAnimationFrame(() =>
        globalThis.pawnTypingFrames.push(performance.now() - start)
      );
    };
    globalThis.addEventListener("keydown", globalThis.pawnRecordKey, true);
  });
  const text =
    "\n// " + name + " real typing 0123456789 abcdefghijklmnopqrstuvwxyz\n";
  const started = Date.now();
  await page.keyboard.type(text, { delay: 0 });
  await frames();
  const milliseconds = Date.now() - started;
  const samples = await page.evaluate(() => {
    globalThis.removeEventListener("keydown", globalThis.pawnRecordKey, true);
    return globalThis.pawnTypingFrames.sort((first, second) => first - second);
  });
  if (profiler) {
    const { profile } = await profiler.send("Profiler.stop");
    await mkdir(path.join(root, "test-results"), { recursive: true });
    await writeFile(
      path.join(root, "test-results/performance-" + name + ".cpuprofile"),
      JSON.stringify(profile)
    );
    console.log(
      name + " CPU samples:",
      profile.nodes
        .filter((node) => node.hitCount > 20)
        .sort((first, second) => second.hitCount - first.hitCount)
        .slice(0, 12)
        .map((node) => ({
          function: node.callFrame.functionName,
          hits: node.hitCount,
          url: node.callFrame.url,
        }))
    );
  }
  assert.ok(samples.length >= 50, "Expected actual keyboard samples");
  assert.equal(
    await evaluate(
      (workbench, text) =>
        Reflect.get(workbench, "codeEditor")
          .getModel()
          .getValue()
          .endsWith(text),
      text
    ),
    true
  );
  const round = (number) => Math.round(number * 10) / 10;
  return {
    name,
    characters: text.length,
    milliseconds,
    samples: samples.length,
    medianFrameMs: round(samples[Math.floor(samples.length / 2)]),
    p95FrameMs: round(samples[Math.floor(samples.length * 0.95)]),
    maximumFrameMs: round(samples.at(-1)),
  };
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
  // Real local files, not an injected tree; process modest batches to avoid handle exhaustion.
  for (let start = 0; start < 2500; start += 50) {
    await Promise.all(
      Array.from({ length: 50 }, (_, offset) =>
        writeFile(
          path.join(
            directory,
            "asset-" + String(start + offset).padStart(4, "0") + ".txt"
          ),
          "workspace asset\n"
        )
      )
    );
  }
  await writeFile(
    path.join(directory, "main.pwn"),
    '#include "math.inc"\nmain() { return Add(1, 2); }\n' +
      Array.from(
        { length: 30_000 },
        (_, index) => "stock Generated" + index + "() { return " + index + "; }"
      ).join("\n") +
      "\n"
  );
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
  await page.getByRole("button", { name: directory, exact: true }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(2503);
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().languagePhase))
    .toBe("ready");
  const id = await evaluate(
    (workbench) => Reflect.get(workbench, "codeEditor").getModel().id
  );
  const visible = await measure("visible");
  await page.keyboard.press("Control+b");
  const hidden = await measure("hidden");
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("treeitem")).toHaveCount(2503);
  const restored = await measure("restored");
  await page.keyboard.press("Control+Shift+f");
  await page.getByLabel("Search text", { exact: true }).fill("workspace asset");
  await expect(page.locator(".search-results button")).toHaveCount(500);
  const search = await measure("search");
  assert.equal(
    await evaluate(
      (workbench) => Reflect.get(workbench, "codeEditor").getModel().id
    ),
    id
  );
  assert.ok(
    await evaluate((workbench) =>
      workbench.getSnapshot().tabs.some((tab) => tab.dirty)
    )
  );
  assert.deepEqual(errors, []);
  const measurements = {
    baseline,
    treeFiles: 2503,
    generatedFunctions: 30_000,
    visible,
    hidden,
    restored,
    search,
  };
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(
      root,
      baseline
        ? "test-results/performance-baseline.json"
        : "test-results/performance-workflows.json"
    ),
    JSON.stringify(measurements, null, 2)
  );
  console.log(JSON.stringify(measurements, null, 2));
  if (!baseline) {
    for (const result of [visible, hidden, restored, search]) {
      assert.ok(
        result.milliseconds < 3000,
        result.name + ": typing blocked for three seconds"
      );
      assert.ok(
        result.p95FrameMs < 100,
        result.name + ": keyboard-to-frame p95 exceeds 100 ms"
      );
    }
  }
} catch (error) {
  console.error("Performance verification failed:", error);
  console.error("Browser errors:", errors);
  throw error;
} finally {
  try {
    await evaluate((workbench) => {
      globalThis.pawnCloseTrace = [];
      const client = Reflect.get(workbench, "language")?.client;
      if (client) {
        const stop = client.stop.bind(client);
        client.stop = async (...args) => {
          globalThis.pawnCloseTrace.push({
            name: "client.stop",
            stage: "start",
            time: performance.now(),
          });
          try {
            return await stop(...args);
          } finally {
            globalThis.pawnCloseTrace.push({
              name: "client.stop",
              stage: "done",
              time: performance.now(),
            });
          }
        };
      }
      for (const name of [
        "closeAll",
        "stopLanguage",
        "stopWatching",
        "removeDocument",
      ]) {
        const operation = Reflect.get(workbench, name).bind(workbench);
        Reflect.set(workbench, name, async (...args) => {
          const start = performance.now();
          globalThis.pawnCloseTrace.push({ name, stage: "start", time: start });
          try {
            const result = await operation(...args);
            globalThis.pawnCloseTrace.push({
              name,
              stage: "done",
              time: performance.now(),
              result,
            });
            return result;
          } catch (error) {
            globalThis.pawnCloseTrace.push({
              name,
              stage: "error",
              time: performance.now(),
              error: String(error),
            });
            throw error;
          }
        });
      }
    });
    const closeStarted = Date.now();
    const closed = page.waitForEvent("close", { timeout: 10_000 });
    await evaluate(async (workbench) => {
      await Reflect.get(workbench, "settingsQueue");
      workbench.subscribe(() => {
        if (workbench.getSnapshot().prompt) workbench.answerPrompt("discard");
      });
      await workbench.quit();
    });
    await waitForClose(closed);
    const closeMilliseconds = Date.now() - closeStarted;
    await writeFile(
      path.join(root, "test-results/performance-close.json"),
      JSON.stringify({ closeMilliseconds }, null, 2)
    );
    console.log(
      "Dirty large-document window closed in " + closeMilliseconds + " ms."
    );
  } finally {
    if (seeded) {
      if (previous) await writeFile(preferences, previous);
      else await rm(preferences, { force: true });
    }
    await browser.close();
    const entries = await readdir(directory, { withFileTypes: true });
    assert.ok(
      entries.every(
        (entry) =>
          entry.isFile() &&
          /^(asset-\d{4}\.txt|main\.pwn|math\.inc|pawn\.json)$/.test(entry.name)
      ),
      "Cleanup is limited to this probe's generated fixture files"
    );
    for (let start = 0; start < entries.length; start += 50) {
      await Promise.all(
        entries.slice(start, start + 50).map((entry) =>
          rm(path.join(directory, entry.name), {
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          })
        )
      );
    }
    await removeEmptyFixtureFolder();
  }
}
