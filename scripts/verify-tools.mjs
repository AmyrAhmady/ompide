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
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { removeTemporary } from "./release-support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageArgument = process.argv.indexOf("--package");
const packaged =
  packageArgument < 0 ? undefined : process.argv[packageArgument + 1];
if (packageArgument >= 0 && !packaged)
  throw new Error("--package requires an extracted release directory");
const binaries = path.join(root, "src-tauri/binaries");
const tool = (name) =>
  packaged
    ? path.join(packaged, `${name}.exe`)
    : path.join(binaries, `${name}-x86_64-pc-windows-msvc.exe`);
const compiler = path.join(
  packaged ?? binaries,
  `${packaged ? "binaries/" : ""}compiler/pawnc-3.10.11-windows/bin/pawncc.exe`
);
const bridgePath = path.join(
  root,
  "src-tauri/target/debug/pawn-lsp-bridge.exe"
);
const workspace = await mkdtemp(path.join(tmpdir(), "ompide "));
const pins = JSON.parse(
  await readFile(path.join(root, "toolchain/tools.json"), "utf8")
);
const versions = Object.fromEntries(
  pins.tools.map((tool) => [tool.name, tool.version])
);
const evidence = {
  pawnlsp: versions.pawnlsp,
  compiler: versions.pawncc,
  checks: [],
};

function compile(workspace, expected) {
  const artifact = path.join(workspace, "output/main.amx");
  const result = spawnSync(
    compiler,
    [
      path.join(workspace, "main.pwn"),
      "-D" + workspace,
      "-i" + workspace,
      "-o" + artifact,
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }
  );
  if (result.error) throw result.error;
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}

function position(text, offset) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
}

function fileUri(file) {
  // Match the frontend's protocolUri and Go's spelling of this unreserved character.
  return pathToFileURL(file).href.replaceAll("%7E", "~");
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
    const uri = fileUri(path.join(workspace, "main.pwn"));
    let source = (await readFile(path.join(workspace, "main.pwn"), "utf8"))
      .replace("new result", "/* 🦀 */ new result")
      .replace(/\r?\n/g, "\r\n");
    const initialized = await request("initialize", {
      processId: process.pid,
      rootUri: fileUri(workspace),
      workspaceFolders: [
        { uri: fileUri(workspace), name: path.basename(workspace) },
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
    // Node escapes '~' as %7E; Go leaves it literal. Compare the actual files,
    // including Windows short-path aliases, rather than serialized URI spelling.
    const definitionPaths = await Promise.all(
      (Array.isArray(definitions) ? definitions : [definitions]).map(
        async (location) => {
          const target = location?.uri ?? location?.targetUri;
          return target ? realpath(fileURLToPath(target)) : undefined;
        }
      )
    );
    const expectedDefinition = await realpath(path.join(workspace, "math.inc"));
    assert.ok(
      definitionPaths.includes(expectedDefinition),
      JSON.stringify({ expectedDefinition, definitions })
    );
    const formatting = await request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.ok(Array.isArray(formatting));
    const includeUri = fileUri(path.join(workspace, "math.inc"));
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
  await cp(path.join(root, "fixtures/minimal"), workspace, {
    recursive: true,
    filter: (file) => !file.includes(path.sep + "output"),
  });
  await mkdir(path.join(workspace, "output"), { recursive: true });
  const valid = compile(workspace, 0);
  assert.ok(valid.stdout.includes("Pawn compiler " + versions.pawncc));
  const artifact = await readFile(path.join(workspace, "output/main.amx"));
  assert.ok(artifact.length > 56);
  assert.equal(artifact.readUInt16LE(4), 0xf1e0);
  evidence.checks.push(
    "Direct pinned open.mp compiler emits a real 32-bit AMX with no CLI wrapper"
  );
  const lspWorkspace = path.join(workspace, "LSP 🦀 # ~ %");
  await cp(path.join(root, "fixtures/minimal"), lspWorkspace, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  await verifyLsp(lspWorkspace);
  await writeFile(
    path.join(workspace, "main.pwn"),
    "main() { MissingFunction(); }\n"
  );
  await rm(path.join(workspace, "output/main.amx"));
  const invalid = compile(workspace, 1);
  assert.match(invalid.stdout + invalid.stderr, /error 017:.*MissingFunction/);
  await assert.rejects(stat(path.join(workspace, "output/main.amx")), {
    code: "ENOENT",
  });
  evidence.failureOutput = invalid.stdout + invalid.stderr;
  evidence.checks.push(
    "Broken source fails with actual compiler error output; native/core tests verify diagnostic parsing and stale-artifact cleanup"
  );
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/tool-integration.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.checks.join("\n"));
} finally {
  await removeTemporary(workspace, tmpdir(), "ompide ");
}
