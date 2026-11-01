// Explicit developer/release preparation. The application never invokes this script.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  copyFile,
  readdir,
  cp,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listFiles, removeTemporary } from "./release-support.mjs";
import { copyPackageNotices } from "./release-notices.mjs";
import {
  selectGo,
  goBuildEnvironment,
  goModuleDirectory,
  goExecutableArgument,
} from "./go-toolchain.mjs";
import { localBuildMatches, buildRecord } from "./lsp-build-record.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, ".tools-cache");
const pin = JSON.parse(
  await readFile(path.join(root, "toolchain/pawnlsp-build.json"), "utf8")
);
const tools = JSON.parse(
  await readFile(path.join(root, "toolchain/tools.json"), "utf8")
);
const tool = tools.tools.find((tool) => tool.name === "pawnlsp");
const destination = path.join(root, "src-tauri/binaries", tool.destination);
const licenseDirectory = path.join(root, "src-tauri/binaries/licenses");
const licenseIndex = path.join(licenseDirectory, "pawnlsp-dependencies.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const download = process.argv.includes("--download");
const reproducible = process.argv.includes("--reproducible");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("This server build is verified only for Windows x64.");
if (!process.argv.includes("--rebuild")) {
  try {
    const notices = JSON.parse(await readFile(licenseIndex, "utf8"));
    const noticeFiles = new Set(
      await listFiles(path.join(licenseDirectory, "pawnlsp-dependencies"))
    );
    if (
      localBuildMatches(
        notices,
        pin,
        tool,
        sha256(await readFile(destination)),
        reproducible
      ) &&
      Array.isArray(notices.dependencies) &&
      notices.dependencies.length > 0 &&
      notices.dependencies.every(
        (dependency) =>
          Array.isArray(dependency.notices) &&
          dependency.notices.length > 0 &&
          dependency.notices.every((file) => noticeFiles.has(file))
      )
    ) {
      console.log(`Verified cached pawnlsp ${pin.version}`);
      process.exit(0);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const environment = goBuildEnvironment(process.env, download, reproducible);
const { executable: go, version: goVersion } = await selectGo({
  executable: goExecutableArgument(process.argv.slice(2)),
  version: pin.minimumGoVersion,
  exactVersion: reproducible ? pin.goVersion : undefined,
  environment,
});
console.log(`Using ${goVersion} : ${go}`);

await mkdir(cache, { recursive: true });
const archive = path.join(cache, pin.source.archive);
let bytes;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!bytes) {
  if (!download)
    throw new Error(
      `Missing ${archive}. Supply the pinned archive manually or explicitly run tools:build-lsp with --download. Source: ${pin.source.url}`
    );
  console.log(`Downloading pinned PawnKit source: ${pin.source.url}`);
  const response = await fetch(pin.source.url);
  if (!response.ok)
    throw new Error(`Source download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.source.sha256)
    throw new Error("Source archive checksum mismatch");
  await writeFile(archive, bytes);
}
if (sha256(bytes) !== pin.source.sha256)
  throw new Error("Source archive checksum mismatch");
const patch = path.join(root, "toolchain", pin.patch.path);
if (sha256(await readFile(patch)) !== pin.patch.sha256)
  throw new Error("Source patch checksum mismatch");
const staging = await mkdtemp(path.join(cache, "pawnlsp-build-"));
try {
  const prefix = `pawnlsp-${pin.source.commit}`;
  const entries = execFileSync("tar", ["-tf", archive], {
    encoding: "utf8",
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/);
  if (
    entries.some(
      (entry) =>
        !entry.startsWith(`${prefix}/`) ||
        entry.replaceAll("\\", "/").split("/").includes("..")
    )
  )
    throw new Error("Unsafe source archive path");
  execFileSync("tar", ["-xf", archive, "-C", staging], { windowsHide: true });
  const source = path.join(staging, prefix);
  const moduleText = await readFile(path.join(source, "go.mod"), "utf8");
  if (
    `go${moduleText.match(/^go\s+(\d+\.\d+\.\d+)\s*$/m)?.[1]}` !==
    pin.minimumGoVersion
  )
    throw new Error("Pinned minimum Go version disagrees with upstream go.mod");
  const directory = path.relative(root, source).replaceAll("\\", "/");
  execFileSync("git", ["apply", "--check", `--directory=${directory}`, patch], {
    cwd: root,
    windowsHide: true,
  });
  execFileSync("git", ["apply", `--directory=${directory}`, patch], {
    cwd: root,
    windowsHide: true,
  });
  const runGo = (args) =>
    execFileSync(go, args, {
      cwd: source,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
  // Authenticate the official GitHub mirror trees against the original, canonical Go module sums.
  for (const dependency of pin.dependencyMirrors) {
    const directory = goModuleDirectory(
      go,
      `${dependency.mirror}@${dependency.version}`,
      { cwd: source, env: environment }
    );
    const files = [];
    const walk = async (relative) => {
      for (const entry of await readdir(path.join(directory, relative), {
        withFileTypes: true,
      })) {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) files.push(file);
        else throw new Error("Unexpected dependency link");
      }
    };
    await walk("");
    const hash = createHash("sha256");
    for (const file of files.sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b))
    ))
      hash.update(
        `${sha256(await readFile(path.join(directory, file)))}  ${dependency.module}@${dependency.version}/${file}\n`
      );
    if (`h1:${hash.digest("base64")}` !== dependency.canonicalChecksum)
      throw new Error(
        `Canonical dependency checksum mismatch: ${dependency.module}`
      );
  }
  runGo(["test", "-mod=readonly", "./..."]);
  const executable = path.join(staging, "pawnlsp.exe");
  runGo([
    "build",
    "-mod=readonly",
    "-trimpath",
    "-buildvcs=false",
    `-ldflags=-s -w -buildid= -X main.version=${pin.version}`,
    "-o",
    executable,
    "./cmd/pawnlsp",
  ]);
  const builtHash = sha256(await readFile(executable));
  if (
    (reproducible || goVersion === pin.goVersion) &&
    builtHash !== tool.executableSha256
  ) {
    await copyFile(executable, path.join(cache, "pawnlsp-reproduction.exe"));
    throw new Error(
      `Built server checksum ${builtHash} differs from the pinned artifact ${tool.executableSha256}`
    );
  }
  const buildInfo = JSON.parse(
    execFileSync(go, ["version", "-m", "-json", executable], {
      cwd: source,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
    })
  );
  const noticeStaging = path.join(staging, "notices");
  await mkdir(noticeStaging);
  const dependencies = [
    await copyPackageNotices(source, noticeStaging, {
      ecosystem: "go",
      name: buildInfo.Main.Path,
      version: pin.version,
    }),
  ];
  for (const dependency of buildInfo.Deps) {
    const module = dependency.Replace || dependency;
    const metadata = JSON.parse(
      execFileSync(
        go,
        ["mod", "download", "-json", `${module.Path}@${module.Version}`],
        {
          cwd: source,
          env: environment,
          encoding: "utf8",
          windowsHide: true,
        }
      )
    );
    if (!metadata.Dir)
      throw new Error(
        `Missing source notices for ${module.Path}@${module.Version}`
      );
    dependencies.push(
      await copyPackageNotices(metadata.Dir, noticeStaging, {
        ecosystem: "go",
        name: dependency.Path,
        version: dependency.Version,
      })
    );
  }
  await mkdir(licenseDirectory, { recursive: true });
  const noticeDestination = path.join(licenseDirectory, "pawnlsp-dependencies");
  try {
    await removeTemporary(
      noticeDestination,
      licenseDirectory,
      "pawnlsp-dependencies"
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(noticeStaging, noticeDestination, { recursive: true });
  await writeFile(
    licenseIndex,
    JSON.stringify(
      {
        schemaVersion: 1,
        executableSha256: builtHash,
        build: buildRecord(pin, goVersion),
        dependencies,
      },
      null,
      2
    ) + "\n"
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(executable, destination);
  console.log(
    `Verified pawnlsp ${pin.version} built with ${goVersion}: ${builtHash}`
  );
} finally {
  await removeTemporary(staging, cache, "pawnlsp-build-");
}
