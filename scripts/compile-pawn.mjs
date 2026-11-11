import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./release-support.mjs";
import { compilerEnvironment, toolManifest } from "./toolchain-target.mjs";

async function compile([workspaceArgument, entryArgument, ...includes]) {
  if (!workspaceArgument || !entryArgument) {
    throw new Error(
      "Usage: npm run pawn:compile -- <workspace> <entry.pwn> [include directory ...]"
    );
  }

  const workspace = path.resolve(workspaceArgument);
  const entry = path.resolve(workspace, entryArgument);
  if (
    path.extname(entry).toLowerCase() !== ".pwn" ||
    !(await stat(entry)).isFile()
  ) {
    throw new Error(`Expected a Pawn source file: ${entry}`);
  }
  const includePaths = includes.map((include) =>
    path.resolve(workspace, include)
  );
  for (const include of includePaths) {
    if (!(await stat(include)).isDirectory()) {
      throw new Error(`Expected an include directory: ${include}`);
    }
  }

  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = await toolManifest(root);
  const pin = manifest.tools.find((tool) => tool.name === "pawncc");
  const binaries = path.join(root, "src-tauri/binaries");
  const compiler = path.join(binaries, pin.destination);
  const files = [[compiler, pin.executableSha256]];
  for (const companion of pin.companions) {
    const file = companion.destination
      ? path.join(binaries, companion.destination)
      : path.join(path.dirname(compiler), companion.name);
    files.push([file, companion.sha256]);
  }
  for (const [file, expected] of files) {
    const bytes = await readFile(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      throw new Error(
        `Missing compiler file ${file}. Run npm run tools:prepare first.`
      );
    });
    if (sha256(bytes) !== expected) {
      throw new Error(`Compiler checksum mismatch: ${file}`);
    }
  }

  const results = path.join(root, "test-results");
  await mkdir(results, { recursive: true });
  const directory = await mkdtemp(path.join(results, "pawn-compile-"));
  const artifact = path.join(directory, `${path.parse(entry).name}.amx`);
  const directories = new Set([
    workspace,
    path.dirname(entry),
    ...includePaths,
  ]);
  const result = spawnSync(
    compiler,
    [
      entry,
      `-D${workspace}`,
      ...[...directories].map((dir) => `-i${dir}`),
      `-o${artifact}`,
    ],
    {
      cwd: workspace,
      env: compilerEnvironment(compiler),
      stdio: "inherit",
      timeout: 120_000,
    }
  );
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(`Compiler terminated with signal ${result.signal}`);
  }
  if (result.status !== 0) return result.status;

  const file = await open(artifact, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(6);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (
      size < 56 ||
      bytesRead !== header.length ||
      header.readUInt16LE(4) !== 0xf1e0
    ) {
      throw new Error(`Compiler output is not a valid AMX: ${artifact}`);
    }
    console.log(`AMX: ${artifact} (${size} bytes)`);
  } finally {
    await file.close();
  }
  return 0;
}

try {
  process.exitCode = await compile(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
