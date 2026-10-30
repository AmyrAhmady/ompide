import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const root = fileURLToPath(new URL("../", import.meta.url));
const binaries = path.join(root, "src-tauri/binaries");
const tool = (name) =>
  path.join(binaries, `${name}-x86_64-pc-windows-msvc.exe`);
const compiler = path.join(
  binaries,
  "compiler/pawnc-3.10.11-windows/bin/pawncc.exe"
);
const bridgePath = path.join(
  root,
  "src-tauri/target/debug/pawn-lsp-bridge.exe"
);
const workspace = await mkdtemp(path.join(tmpdir(), "pawn ide "));
const pins = JSON.parse(
  await readFile(path.join(root, "toolchain/tools.json"), "utf8")
);
const versions = Object.fromEntries(
  pins.tools.map((tool) => [tool.name, tool.version])
);
const evidence = {
  pawnlsp: versions.pawnlsp,
  pawn: versions.pawn,
  compiler: versions.pawncc,
  checks: [],
};

function run(args, expected = 0) {
  const result = spawnSync(tool("pawn"), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expected,
    `${args.join(" ")}\n${result.stderr}\n${result.stdout}`
  );
  return JSON.parse(result.stdout);
}

function position(text, offset) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
}

async function verifyLsp(workspace) {
  const child = spawn(bridgePath, [tool("pawnlsp"), workspace], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const errors = [];
  let id = 0;
  let closeResolve;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const protocolClosed = new Promise((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = JSON.parse(line);
      if (event.kind === "message") {
        const message = JSON.parse(event.body);
        if (message.method && message.id !== undefined) {
          // Handle standard server-to-client requests without inventing Pawn semantics.
          notifyResponse(
            message.id,
            message.method === "workspace/configuration" ? [] : null
          );
        } else if (message.id !== undefined) {
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          clearTimeout(request.timeout);
          if (message.error)
            request.reject(new Error(JSON.stringify(message.error)));
          else request.resolve(message.result);
        }
      } else if (event.kind === "error") errors.push(event.body);
      else if (event.kind === "closed") resolve();
    });
  });
  child.stderr.on("data", (data) => errors.push(data.toString()));
  child.on("error", (error) => {
    errors.push(error.message);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  });
  child.on("close", (code) => closeResolve(code));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const notifyResponse = (requestId, result) =>
    send({ jsonrpc: "2.0", id: requestId, result });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timeout: ${method}\n${errors.join("\n")}`));
      }, 15_000);
      pending.set(requestId, { resolve, reject, timeout });
      send({ jsonrpc: "2.0", id: requestId, method, params });
    });
  try {
    const uri = pathToFileURL(path.join(workspace, "main.pwn")).href;
    let source = (await readFile(path.join(workspace, "main.pwn"), "utf8"))
      .replace("new result", "/* 🦀 */ new result")
      .replace(/\r?\n/g, "\r\n");
    const initialized = await request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(workspace).href,
      workspaceFolders: [
        { uri: pathToFileURL(workspace).href, name: path.basename(workspace) },
      ],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { synchronization: { didSave: true }, diagnostic: {} },
      },
    });
    assert.equal(initialized.capabilities.textDocumentSync, 2);
    assert.equal(
      initialized.capabilities.positionEncoding ?? "utf-16",
      "utf-16"
    );
    evidence.capabilities = initialized.capabilities;
    notify("initialized", {});
    notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "pawn", version: 1, text: source },
    });
    const at = position(source, source.indexOf("Add(1") + 2);
    const completions = await request("textDocument/completion", {
      textDocument: { uri },
      position: at,
    });
    assert.ok(
      (Array.isArray(completions) ? completions : completions.items).some(
        (item) => item.label === "Add"
      ),
      JSON.stringify(completions)
    );
    const definitions = await request("textDocument/definition", {
      textDocument: { uri },
      position: at,
    });
    assert.ok(
      (Array.isArray(definitions) ? definitions : [definitions]).some(
        (location) =>
          (location?.uri ?? location?.targetUri) ===
          pathToFileURL(path.join(workspace, "math.inc")).href
      ),
      JSON.stringify(definitions)
    );
    const formatting = await request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.ok(Array.isArray(formatting));
    const includeUri = pathToFileURL(path.join(workspace, "math.inc")).href;
    notify("textDocument/didOpen", {
      textDocument: {
        uri: includeUri,
        languageId: "pawn",
        version: 1,
        text: await readFile(path.join(workspace, "math.inc"), "utf8"),
      },
    });
    notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 2 }] });
    await rename(
      path.join(workspace, "main.pwn"),
      path.join(workspace, "moved.pwn")
    );
    notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 2 }] });
    await request("textDocument/diagnostic", { textDocument: { uri } });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(
          path.join(workspace, "moved.pwn"),
          path.join(workspace, "main.pwn")
        );
        break;
      } catch (error) {
        if (attempt >= 10 || !["EBUSY", "EPERM"].includes(error.code))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 2 }] });
    // Sequential incremental edits use UTF-16 positions and CRLF, including a surrogate pair.
    const header = "// 🦀 فارسی\r\n";
    source = header + source;
    const replaceAt = source.indexOf("Add(1");
    notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          text: header,
        },
        {
          range: {
            start: { line: 0, character: 3 },
            end: { line: 0, character: 5 },
          },
          text: "😀",
        },
        {
          range: {
            start: position(source, replaceAt),
            end: position(source, replaceAt + "Add(1, 2)".length),
          },
          text: "Add( 1 )",
        },
      ],
    });
    source = source.replace("🦀", "😀").replace("Add(1, 2)", "Add( 1 )");
    // pawnlsp can initially return analysis-only diagnostics while lint finishes in the background.
    let diagnostics;
    const deadline = Date.now() + 5000;
    do {
      diagnostics = await request("textDocument/diagnostic", {
        textDocument: { uri },
      });
      if (
        diagnostics.items.some(
          (item) => item.code === "pawn-analysis:sema/argument-count"
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(
      diagnostics.items.some(
        (item) => item.code === "pawn-analysis:sema/argument-count"
      ),
      JSON.stringify(diagnostics)
    );
    const changedFormatting = await request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.ok(
      changedFormatting.some(
        (edit) =>
          edit.newText.includes("😀 فارسی") && edit.newText.includes("Add(1)")
      ),
      JSON.stringify(changedFormatting)
    );
    evidence.diagnostics = diagnostics.items;
    const invalidSource = source;
    const validSource = source.replace("Add( 1 )", "Add( 1, 2 )");
    let version = 2;
    for (const fullRange of [false, true]) {
      for (const invalid of [false, true, false]) {
        const change = { text: invalid ? invalidSource : validSource };
        if (fullRange)
          change.range = {
            start: { line: 0, character: 0 },
            end: position(source, source.length),
          };
        source = change.text;
        notify("textDocument/didChange", {
          textDocument: { uri, version: ++version },
          contentChanges: [change],
        });
        const refreshDeadline = Date.now() + 5000;
        do {
          diagnostics = await request("textDocument/diagnostic", {
            textDocument: { uri },
          });
          if (
            diagnostics.items.some(
              (item) => item.code === "pawn-analysis:sema/argument-count"
            ) === invalid
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < refreshDeadline);
        assert.equal(
          diagnostics.items.some(
            (item) => item.code === "pawn-analysis:sema/argument-count"
          ),
          invalid,
          JSON.stringify(diagnostics)
        );
      }
    }
    evidence.checks.push(
      "Repeated full-text and full-range entry edits publish and clear real argument-count diagnostics with both project files open."
    );
    notify("textDocument/didSave", { textDocument: { uri }, text: source });
    notify("textDocument/didClose", { textDocument: { uri } });
    await request("shutdown", null);
    notify("exit", null);
    await Promise.race([
      protocolClosed,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("LSP did not exit")),
          5000
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(errors, []);
    evidence.checks.push(
      "Real pawnlsp through Rust-owned stdio: initialization, completion, cross-file definition, formatting, incremental Unicode/CRLF edits, diagnostics, save/close, shutdown/exit"
    );
  } finally {
    child.stdin.end();
    await closed;
    for (const request of pending.values()) clearTimeout(request.timeout);
  }
}

try {
  assert.equal(
    spawnSync(tool("pawnlsp"), ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(),
    versions.pawnlsp
  );
  assert.equal(
    spawnSync(tool("pawn"), ["version"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(),
    `pawn ${versions.pawn}`
  );
  await cp(path.join(root, "fixtures/minimal"), workspace, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  const project = run(["project", "--project", workspace, "--output", "json"]);
  assert.equal(project.schemaVersion, 1);
  assert.equal(project.entry, path.join(workspace, "main.pwn"));
  evidence.project = project;
  const doctor = spawnSync(
    tool("pawn"),
    ["doctor", "--project", workspace, "--output", "json"],
    { encoding: "utf8", timeout: 30_000, windowsHide: true }
  );
  assert.ok([0, 1].includes(doctor.status), doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).schemaVersion, 1);
  const args = [
    "build",
    "--project",
    workspace,
    "--compiler",
    compiler,
    "--artifact",
    "output/main.amx",
    "--format",
    "json",
  ];
  const valid = run(args);
  assert.equal(valid.schemaVersion, 2);
  assert.equal(valid.status, "passed");
  assert.equal(valid.process.exitCode, 0);
  assert.ok(valid.process.stdout.includes(`Pawn compiler ${versions.pawncc}`));
  assert.ok((await stat(valid.artifacts[0].path)).size > 0);
  evidence.checks.push(
    "Real PawnKit project/doctor schema 1; build schema 2 with explicit offline compiler; valid fixture emits AMX"
  );
  const lspWorkspace = path.join(workspace, "LSP 🦀 #");
  await cp(path.join(root, "fixtures/minimal"), lspWorkspace, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  await verifyLsp(lspWorkspace);
  await writeFile(
    path.join(workspace, "main.pwn"),
    "main() { MissingFunction(); }\n"
  );
  const invalid = run(args, 1);
  assert.equal(invalid.status, "failed");
  assert.notEqual(invalid.process.exitCode, 0);
  assert.ok(
    invalid.diagnostics.some(
      (item) =>
        item.severity === "error" && item.primary.uri.startsWith("file:")
    )
  );
  await assert.rejects(stat(path.join(workspace, "output/main.amx")), {
    code: "ENOENT",
  });
  evidence.failureReport = invalid;
  evidence.checks.push(
    "Broken fixture fails with structured compiler diagnostics and removes stale AMX"
  );
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/tool-integration.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.checks.join("\n"));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
