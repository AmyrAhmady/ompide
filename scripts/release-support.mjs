import { createHash } from "node:crypto";
import {
  appendFile,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function cargoExecutable(
  { profile, target, executable, binary = "ompide.exe", root = projectRoot },
  run = execFileSync
) {
  if (executable) return path.resolve(root, executable);
  const metadata = JSON.parse(
    run(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        path.join(root, "src-tauri/Cargo.toml"),
        "--no-deps",
        "--format-version",
        "1",
      ],
      { cwd: root, encoding: "utf8", windowsHide: true }
    )
  );
  if (typeof metadata.target_directory !== "string")
    throw new Error("Cargo did not report its target directory");
  const candidates = [
    path.join(metadata.target_directory, profile, binary),
    path.join(metadata.target_directory, target, profile, "ompide.exe"),
  ];
  const found = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) found.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (found.length !== 1)
    throw new Error(
      found.length
        ? "Multiple application builds found. Pass --executable <path> to select the one to package."
        : "No application build found in Cargo's target directory. Build first or pass --executable <path>."
    );
  return found[0];
}

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function releaseSettings(root = projectRoot) {
  const json = async (file) =>
    JSON.parse(await readFile(path.join(root, file), "utf8"));
  const pkg = await json("package.json");
  const config = await json("src-tauri/tauri.conf.json");
  const tools = await json("toolchain/tools.json");
  const server = await json("toolchain/pawnlsp-build.json");
  const cargo = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const rust = await readFile(path.join(root, "rust-toolchain.toml"), "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const rustVersion = rust.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version) ||
    !/^\d+\.\d+\.\d+$/.test(rustVersion ?? "") ||
    !/^go\d+\.\d+\.\d+$/.test(server.goVersion ?? "")
  ) {
    throw new Error(
      "Release and Rust versions must be explicit, valid versions"
    );
  }
  if (pkg.version !== config.version || pkg.version !== cargoVersion) {
    throw new Error(
      "package.json, Cargo.toml and tauri.conf.json versions must match"
    );
  }
  if (tools.target !== "x86_64-pc-windows-msvc")
    throw new Error("Release packaging currently supports Windows x64 only");
  if (
    process.env.GITHUB_REF?.startsWith("refs/tags/") &&
    process.env.GITHUB_REF !== `refs/tags/v${pkg.version}`
  ) {
    throw new Error(`The release tag must be v${pkg.version}`);
  }
  return {
    version: pkg.version,
    rustVersion,
    goVersion: server.goVersion.replace(/^go/, ""),
    target: tools.target,
    tools,
  };
}

export async function listFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(directory, name)));
    else if (entry.isFile()) files.push(name);
    else
      throw new Error(
        `Links and special files are not allowed in release packages: ${name}`
      );
  }
  return files.sort();
}

export async function removeTemporary(directory, parent, prefix) {
  const absolute = await realpath(directory);
  const expectedParent = await realpath(parent);
  if (
    path.dirname(absolute) !== expectedParent ||
    !path.basename(absolute).startsWith(prefix)
  ) {
    throw new Error(
      "Refusing to remove an unexpected release staging directory"
    );
  }
  await rm(absolute, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

export function peInfo(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ")
    throw new Error("Not a Windows executable");
  const pe = bytes.readUInt32LE(60);
  if (
    pe + 24 > bytes.length ||
    bytes.toString("ascii", pe, pe + 4) !== "PE\0\0"
  )
    throw new Error("Invalid PE header");
  const machine = bytes.readUInt16LE(pe + 4);
  const sections = bytes.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const magic = bytes.readUInt16LE(optional);
  const directories =
    optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
  const sectionTable = optional + optionalSize;
  if (
    directories === optional ||
    directories + 16 > sectionTable ||
    sectionTable + sections * 40 > bytes.length
  ) {
    throw new Error("Invalid PE sections");
  }

  const offset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const entry = sectionTable + i * 40;
      const size = Math.max(
        bytes.readUInt32LE(entry + 8),
        bytes.readUInt32LE(entry + 16)
      );
      const start = bytes.readUInt32LE(entry + 12);
      if (rva >= start && rva < start + size) {
        const result = bytes.readUInt32LE(entry + 20) + rva - start;
        if (result < bytes.length) return result;
      }
    }
    throw new Error("PE import points outside the executable");
  };
  const imports = [];
  const importRva = bytes.readUInt32LE(directories + 8);
  if (!importRva) return { machine, imports };
  let descriptor = offset(importRva);
  for (;;) {
    if (descriptor + 20 > bytes.length) throw new Error("Truncated PE imports");
    if (bytes.subarray(descriptor, descriptor + 20).every((byte) => byte === 0))
      break;
    const name = offset(bytes.readUInt32LE(descriptor + 12));
    const end = bytes.indexOf(0, name);
    if (end < name || end - name > 256)
      throw new Error("Invalid imported DLL name");
    imports.push(bytes.toString("ascii", name, end).toLowerCase());
    descriptor += 20;
  }
  return { machine, imports };
}

const systemDlls = new Set([
  "advapi32.dll",
  "bcrypt.dll",
  "bcryptprimitives.dll",
  "combase.dll",
  "comctl32.dll",
  "crypt32.dll",
  "d3d11.dll",
  "dbghelp.dll",
  "dnsapi.dll",
  "dwmapi.dll",
  "gdi32.dll",
  "imm32.dll",
  "iphlpapi.dll",
  "kernel32.dll",
  "msvcrt.dll",
  "ncrypt.dll",
  "ntdll.dll",
  "ole32.dll",
  "oleaut32.dll",
  "opengl32.dll",
  "propsys.dll",
  "psapi.dll",
  "rpcrt4.dll",
  "secur32.dll",
  "setupapi.dll",
  "shell32.dll",
  "shcore.dll",
  "shlwapi.dll",
  "ucrtbase.dll",
  "user32.dll",
  "userenv.dll",
  "uxtheme.dll",
  "version.dll",
  "winhttp.dll",
  "winmm.dll",
  "winspool.drv",
  "wintrust.dll",
  "ws2_32.dll",
  "wtsapi32.dll",
]);

export async function verifyPackage(directory, settings) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "release-manifest.json"), "utf8")
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== settings.version ||
    manifest.target !== settings.target
  ) {
    throw new Error(
      "Release manifest does not match the project version/target"
    );
  }
  const actual = await listFiles(directory);
  const recorded = manifest.files.map((entry) => entry.path);
  if (
    new Set(recorded).size !== recorded.length ||
    JSON.stringify([...recorded, "release-manifest.json"].sort()) !==
      JSON.stringify(actual)
  ) {
    throw new Error("Release contains missing, unexpected or duplicate files");
  }
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(directory, entry.path));
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
      throw new Error(`Release file checksum mismatch: ${entry.path}`);
  }
  const compiler = settings.tools.tools.find((tool) => tool.name === "pawncc");
  const server = settings.tools.tools.find((tool) => tool.name === "pawnlsp");
  const compilerPath = `binaries/${compiler.destination}`;
  const compilerFolder = path.posix.dirname(compilerPath);
  const expected = new Map([
    ["pawnlsp.exe", server.executableSha256],
    [compilerPath, compiler.executableSha256],
    ...compiler.companions.map((file) => [
      `${compilerFolder}/${file.name}`,
      file.sha256,
    ]),
  ]);
  for (const [file, hash] of expected) {
    if (sha256(await readFile(path.join(directory, file))) !== hash)
      throw new Error(`Pinned tool checksum mismatch: ${file}`);
  }
  const names = new Set(actual.map((file) => file.toLowerCase()));
  for (const file of actual.filter((name) => /\.(exe|dll)$/i.test(name))) {
    const info = peInfo(await readFile(path.join(directory, file)));
    const machine = file.startsWith(`${compilerFolder}/`) ? 0x14c : 0x8664;
    if (info.machine !== machine)
      throw new Error(`Wrong executable architecture: ${file}`);
    for (const dependency of info.imports) {
      if (
        systemDlls.has(dependency) ||
        /^(api-ms-win-|ext-ms-win-)/.test(dependency)
      )
        continue;
      const adjacent = path.posix
        .join(path.posix.dirname(file), dependency)
        .toLowerCase();
      if (!names.has(adjacent))
        throw new Error(
          `Missing runtime DLL ${dependency}, imported by ${file}`
        );
    }
  }
  for (const required of [
    "ompide.exe",
    `${compilerFolder}/vcruntime140.dll`,
    "LICENSE",
    "README.txt",
    "licenses/ompide.txt",
    "licenses/pawn-grammar.txt",
    "licenses/microsoft-vc-runtime.txt",
    "licenses/dependencies/dependencies.json",
    "binaries/licenses/compiler.txt",
    "binaries/licenses/pawnlsp.txt",
    "binaries/licenses/go.txt",
    "binaries/licenses/pawnlsp-dependencies.json",
  ]) {
    if (!actual.includes(required))
      throw new Error(`Release is missing ${required}`);
  }
  const serverNotices = JSON.parse(
    await readFile(
      path.join(directory, "binaries/licenses/pawnlsp-dependencies.json"),
      "utf8"
    )
  );
  if (
    serverNotices.schemaVersion !== 1 ||
    serverNotices.executableSha256 !== server.executableSha256
  )
    throw new Error(
      "Language server notices do not match the pinned executable"
    );
  const applicationNotices = JSON.parse(
    await readFile(
      path.join(directory, "licenses/dependencies/dependencies.json"),
      "utf8"
    )
  );
  for (const [base, dependencies] of [
    ["binaries/licenses/pawnlsp-dependencies", serverNotices.dependencies],
    ["licenses/dependencies", applicationNotices],
  ]) {
    if (!Array.isArray(dependencies) || !dependencies.length)
      throw new Error("Release dependency notice inventory is empty");
    for (const dependency of dependencies) {
      if (!Array.isArray(dependency.notices) || !dependency.notices.length)
        throw new Error(`Missing license text for ${dependency.name}`);
      for (const notice of dependency.notices) {
        const file = path.posix.join(base, notice);
        if (!file.startsWith(`${base}/`) || !actual.includes(file))
          throw new Error(`Release is missing dependency notice: ${file}`);
      }
    }
  }
  return manifest;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const settings = await releaseSettings();
  console.log(
    `ompide ${settings.version}; Rust ${settings.rustVersion}; Go ${settings.goVersion}; ${settings.target}`
  );
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${settings.version}\nrust=${settings.rustVersion}\ngo=${settings.goVersion}\n`
    );
  }
}
