// Exercise native authorization directly, bypassing frontend validation.
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 15_000 });
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
const directory = await mkdtemp(path.join(tmpdir(), "pawn-security-smoke-"));
const first = path.join(directory, "first");
const second = path.join(directory, "second");
const outside = path.join(directory, "outside");
const sentinel = path.join(outside, "sentinel.inc");
const junction = path.join(first, "outside-link");
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const evidence = [];
const errors = [];
const remoteRequests = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (
    ["http:", "https:"].includes(url.protocol) &&
    !["localhost", "127.0.0.1", "ipc.localhost"].includes(url.hostname)
  )
    remoteRequests.push(url.href);
});
let previous;
let seeded = false;
let linked = false;

async function evaluate(operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const resources = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name);
      const { workbench } = await import(
        resources.find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url))
      );
      const { native } = await import(
        resources.find((url) => /\/src\/lib\/native\.ts(?:\?|$)/.test(url))
      );
      const core = await import(
        resources.find((url) => url.includes("/@tauri-apps_api_core.js"))
      );
      try {
        return await (0, eval)(operation)(workbench, native, argument, core);
      } catch (error) {
        throw new Error(
          typeof error?.code === "string" ? error.code : String(error),
          { cause: error }
        );
      }
    },
    { operation: operation.toString(), argument }
  );
}

async function denied(operation, argument, code = "permissionDenied") {
  await assert.rejects(evaluate(operation, argument), (error) =>
    error.message.includes(code)
  );
}

try {
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const folder of [first, second])
    await cp(path.join(root, "fixtures/minimal"), folder, {
      recursive: true,
      filter: (file) => !file.includes(`${path.sep}output`),
    });
  await mkdir(outside);
  await writeFile(sentinel, "// outside fixture must remain unchanged\n");
  await mkdir(path.join(first, ".git"));
  await writeFile(path.join(first, ".git/protected"), "protected fixture\n");
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [first, second],
      recentFiles: [],
      settings: {},
    })
  );
  await page.reload();
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready))
    .toBe(true);
  await denied(
    (workbench, native, file) => native.read(file),
    sentinel,
    "noWorkspace"
  );
  await denied(
    (workbench, native, folder) => native.activateWorkspace(folder),
    first
  );
  await denied(
    (workbench, native, folder) => native.recentWorkspace(folder),
    outside
  );
  await denied(
    (workbench, native, file) => native.recentDocument(file),
    sentinel
  );
  evidence.push(
    "Unselected files, forged picker activation and unlisted recent files/workspaces cannot create native authority."
  );

  await page.getByRole("button", { name: first, exact: true }).click();
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().languagePhase))
    .toBe("ready");
  for (const operation of [
    (workbench, native, file) => native.read(file),
    (workbench, native, file) => native.rememberDocument(file),
  ])
    await denied(operation, sentinel);
  await denied((workbench, native, folder) => native.entries(folder), outside);
  await denied(
    (workbench, native, folder) => native.inspectProject(folder),
    outside
  );
  await denied(
    (workbench, native, folder) =>
      native.createEntry(folder, "escaped.pwn", false),
    outside
  );
  await denied(
    (workbench, native, file) =>
      native.save(file, "overwritten", false, "fake revision"),
    sentinel
  );
  await denied(
    (workbench, native, file) => native.watch([file], () => {}),
    sentinel
  );
  await denied(
    (workbench, native, file) =>
      native.search(999, { query: "fixture", filesOnly: false }, [
        { path: file, text: "overlay", version: 1 },
      ]),
    sentinel
  );
  await denied((workbench, native, folder) => native.trashEntry(folder), first);
  await denied(
    (workbench, native, file) => native.trashEntry(file),
    path.join(first, ".git/protected")
  );
  await denied(
    (workbench, native, file) => native.renameEntry(file, "../escaped.pwn"),
    path.join(first, "main.pwn"),
    "invalidName"
  );
  await assert.rejects(stat(path.join(outside, "escaped.pwn")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(sentinel, "utf8"),
    "// outside fixture must remain unchanged\n"
  );
  evidence.push(
    "Native reads/writes, enumeration, project inspection, creation, watching and search overlays reject outside paths; root/Git protection and unsafe-name checks do not depend on the UI."
  );

  await symlink(outside, junction, "junction");
  linked = true;
  await denied(
    (workbench, native, file) => native.read(file),
    path.join(junction, "sentinel.inc")
  );
  await denied((workbench, native, folder) => native.entries(folder), junction);
  await denied(
    (workbench, native, folder) => native.renameEntry(folder, "renamed-link"),
    junction
  );
  await unlink(junction);
  linked = false;
  evidence.push(
    "A real Windows junction cannot escape workspace authorization or become a mutable Explorer entry."
  );

  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      evaluate(async (workbench) => {
        const symbols = await Reflect.get(
          workbench,
          "language"
        ).client.sendRequest("workspace/symbol", { query: "main" });
        return symbols.some((symbol) => symbol.name === "main");
      })
    )
    .toBe(true);

  await denied(
    (workbench, native, argument, core) =>
      core.invoke("lsp_send", {
        sessionId: Number.MAX_SAFE_INTEGER,
        body: '{"jsonrpc":"2.0","method":"shutdown","id":123}',
      }),
    null,
    "lspStopped"
  );
  await evaluate(async (workbench, native, argument, core) => {
    await core.invoke("lsp_stop", { sessionId: Number.MAX_SAFE_INTEGER });
    const symbols = await Reflect.get(workbench, "language").client.sendRequest(
      "workspace/symbol",
      { query: "main" }
    );
    if (!symbols.some((symbol) => symbol.name === "main"))
      throw new Error("The real session was affected by a stale request");
  });
  evidence.push(
    "Stale language-session writes are rejected and stale Stop cannot terminate the real server."
  );

  await evaluate(
    (workbench, native, folder) =>
      native.storeSettings({
        theme: "dark",
        recentWorkspaces: [folder],
        recentFiles: [folder + "/sentinel.inc"],
      }),
    outside
  );
  await denied(
    (workbench, native, folder) => native.recentWorkspace(folder),
    outside
  );
  await denied(
    (workbench, native, file) => native.recentDocument(file),
    sentinel
  );
  await evaluate(
    (workbench, native, file) => native.rememberDocument(file),
    path.join(first, "main.pwn")
  );
  await evaluate(
    (workbench, native, folder) => workbench.chooseFolder(folder),
    second
  );
  await denied(
    (workbench, native, file) => native.read(file),
    path.join(first, "main.pwn")
  );
  const reopened = await evaluate(
    (workbench, native, file) => native.recentDocument(file),
    path.join(first, "main.pwn")
  );
  assert.ok(reopened.text.includes("Add(1, 2)"));
  await denied(
    (workbench, native, file) => native.read(file),
    path.join(first, "math.inc")
  );
  evidence.push(
    "Settings cannot forge recent authority; workspace switches revoke broad access, and explicit history reopening authorizes only the selected file."
  );
  assert.equal(
    await readFile(sentinel, "utf8"),
    "// outside fixture must remain unchanged\n"
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/security-workflows.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  console.error("Security verification failed:", error);
  throw error;
} finally {
  try {
    const closed = page.waitForEvent("close", { timeout: 15_000 });
    await evaluate(async (workbench) => {
      await Reflect.get(workbench, "settingsQueue");
      workbench.subscribe(() => {
        if (workbench.getSnapshot().prompt) workbench.answerPrompt("discard");
      });
      await workbench.quit();
    });
    await closed;
  } finally {
    if (linked) await unlink(junction);
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
