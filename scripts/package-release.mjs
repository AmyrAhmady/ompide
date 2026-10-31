import { execFileSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { applicationNotices } from "./release-notices.mjs";
import {
  listFiles,
  projectRoot,
  releaseSettings,
  removeTemporary,
  sha256,
  verifyPackage,
} from "./release-support.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Release packaging currently supports Windows x64 only");
}
const settings = await releaseSettings();
const debug = process.argv.includes("--debug");
if (process.argv.slice(2).some((argument) => argument !== "--debug"))
  throw new Error("Usage: npm run release:package [-- --debug]");
const profile = debug ? "debug" : "release";
const output = path.join(projectRoot, "release");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, ".package-"));
const directory = path.join(temporary, "files");
const name = `ompide-${settings.version}-windows-x64${debug ? "-debug" : ""}.zip`;
const archive = path.join(output, name);

function powershell(script, args = []) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(projectRoot, "scripts", script),
      ...args,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    }
  );
}

async function copy(source, destination) {
  const target = path.join(directory, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(projectRoot, source), target);
}

try {
  const server = settings.tools.tools.find((tool) => tool.name === "pawnlsp");
  const compiler = settings.tools.tools.find((tool) => tool.name === "pawncc");
  const compilerFolder = path.posix.dirname(`binaries/${compiler.destination}`);
  const runtime = JSON.parse(powershell("find-vc-runtime.ps1"));
  await copy(`src-tauri/target/${profile}/ompide.exe`, "ompide.exe");
  await copy(`src-tauri/binaries/${server.destination}`, "pawnlsp.exe");
  await copy(
    `src-tauri/binaries/${compiler.destination}`,
    `binaries/${compiler.destination}`
  );
  for (const companion of compiler.companions) {
    await copy(
      `src-tauri/${compilerFolder}/${companion.name}`,
      `${compilerFolder}/${companion.name}`
    );
  }
  await copyFile(
    runtime.path,
    path.join(directory, compilerFolder, "vcruntime140.dll")
  );
  await cp(
    path.join(projectRoot, "src-tauri/binaries/licenses"),
    path.join(directory, "binaries/licenses"),
    { recursive: true }
  );
  await cp(
    path.join(projectRoot, "src-tauri/licenses"),
    path.join(directory, "licenses"),
    { recursive: true }
  );
  await copy(
    "packaging/windows/microsoft-vc-runtime.txt",
    "licenses/microsoft-vc-runtime.txt"
  );
  await copy("LICENSE", "LICENSE");
  await copy("src/editor/pawn/LICENSE.txt", "licenses/pawn-grammar.txt");
  await applicationNotices(
    path.join(directory, "licenses/dependencies"),
    settings.target
  );
  const readme = await readFile(
    path.join(projectRoot, "packaging/windows/README.txt"),
    "utf8"
  );
  await writeFile(
    path.join(directory, "README.txt"),
    readme.replaceAll("{version}", settings.version)
  );
  const files = [];
  for (const file of await listFiles(directory)) {
    const bytes = await readFile(path.join(directory, file));
    files.push({ path: file, size: bytes.length, sha256: sha256(bytes) });
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  const manifest = {
    schemaVersion: 1,
    version: settings.version,
    target: settings.target,
    profile,
    sourceCommit: git(["rev-parse", "HEAD"]),
    sourceDirty: Boolean(git(["status", "--porcelain"])),
    tools: { pawnlsp: server.version, compiler: compiler.version },
    microsoftRuntime: {
      path: `${compilerFolder}/vcruntime140.dll`,
      version: runtime.version,
      signer: runtime.signer,
    },
    prerequisites: [
      "Windows 10/11 x64",
      "Microsoft Edge WebView2 Runtime",
      "Installed Git for Source Control",
    ],
    files,
  };
  await writeFile(
    path.join(directory, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  await verifyPackage(directory, settings);
  const temporaryArchive = path.join(temporary, name);
  powershell("release-archive.ps1", [
    "-Mode",
    "Create",
    "-Archive",
    temporaryArchive,
    "-Directory",
    directory,
  ]);
  await rename(temporaryArchive, archive);
  const checksum = `${sha256(await readFile(archive))}  ${name}\n`;
  await writeFile(`${archive}.sha256`, checksum);
  console.log(`Created release/${name}\n${checksum.trim()}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `archive=release/${name}\nchecksum=release/${name}.sha256\n`
    );
  }
} finally {
  await removeTemporary(temporary, output, ".package-");
}
