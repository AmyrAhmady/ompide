import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import {
  projectRoot,
  releaseSettings,
  removeTemporary,
  sha256,
  verifyPackage,
} from "./release-support.mjs";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Release verification requires Windows x64");
const settings = await releaseSettings();
const debug = process.argv.includes("--debug");
const archive = path.join(
  projectRoot,
  `release/ompide-${settings.version}-windows-x64${debug ? "-debug" : ""}.zip`
);
const expectedChecksum = (await readFile(`${archive}.sha256`, "utf8")).split(
  /\s+/
)[0];
if (sha256(await readFile(archive)) !== expectedChecksum)
  throw new Error("Release ZIP checksum mismatch");
const output = path.join(projectRoot, "release");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, ".verify-"));
try {
  const directory = path.join(temporary, "extracted");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(projectRoot, "scripts/release-archive.ps1"),
      "-Mode",
      "Extract",
      "-Archive",
      archive,
      "-Directory",
      directory,
    ],
    { stdio: "inherit", windowsHide: true }
  );
  const manifest = await verifyPackage(directory, settings);
  if (manifest.profile !== (debug ? "debug" : "release"))
    throw new Error("The ZIP contains the wrong build profile");
  execFileSync(
    process.execPath,
    [
      path.join(projectRoot, "scripts/verify-tools.mjs"),
      "--package",
      directory,
    ],
    { cwd: projectRoot, stdio: "inherit", windowsHide: true }
  );
  console.log(
    `Extracted ZIP verified: ${manifest.files.length} hashed files, runtime dependency coverage, real bundled LSP and compiler.`
  );
} finally {
  await removeTemporary(temporary, output, ".verify-");
}
