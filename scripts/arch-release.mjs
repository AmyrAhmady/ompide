// Repackage the CI-built Linux payload using Arch's native makepkg tooling.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  projectRoot,
  releaseSettings,
  removeTemporary,
  sha256,
} from "./release-support.mjs";
import { payloadFiles } from "./linux-package-support.mjs";

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Run Arch packaging on the Linux x64 CI runner");
const settings = await releaseSettings();
const input = path.resolve(process.argv[2] ?? "release/linux-debian-payload");
const candidates = (await readdir(input)).filter((file) =>
  file.endsWith(".deb")
);
assert.equal(candidates.length, 1, "Expected one verified Debian payload");
const deb = path.join(input, candidates[0]);
const checksum = await readFile(`${deb}.sha256`, "utf8");
const digest = sha256(await readFile(deb));
assert.equal(
  checksum.trim(),
  `${digest}  ${path.basename(deb)}`,
  "Debian payload checksum mismatch"
);
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120000,
    ...options,
  });
const output = path.join(projectRoot, "release");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, ".arch-package-"));
try {
  const data = run("bsdtar", ["-tf", deb])
    .trim()
    .split(/\r?\n/)
    .filter((name) => /^data\.tar\.(gz|xz|zst)$/.test(name));
  assert.equal(data.length, 1, "Expected one Debian data archive");
  const license = await readFile(path.join(projectRoot, "LICENSE"));
  let recipe = await readFile(
    path.join(projectRoot, "packaging/arch/PKGBUILD.in"),
    "utf8"
  );
  for (const [key, value] of Object.entries({
    VERSION: settings.version.replaceAll("-", "_"),
    DEB_SHA256: digest,
    LICENSE_SHA256: sha256(license),
    DATA_ARCHIVE: data[0],
  }))
    recipe = recipe.replaceAll(`@${key}@`, value);
  await writeFile(path.join(temporary, "PKGBUILD"), recipe);
  await writeFile(path.join(temporary, "LICENSE"), license);
  await copyFile(deb, path.join(temporary, "ompide.deb"));
  // makepkg refuses root; use the dedicated unprivileged CI packaging account.
  run("chown", ["-R", "ompide-build:ompide-build", temporary]);
  run(
    "runuser",
    ["-u", "ompide-build", "--", "makepkg", "--noconfirm", "--cleanbuild"],
    { cwd: temporary, stdio: "inherit" }
  );
  const packages = (await readdir(temporary)).filter((name) =>
    name.endsWith(".pkg.tar.zst")
  );
  assert.equal(packages.length, 1, "Expected one Arch package");
  const archive = path.join(output, packages[0]);
  await copyFile(path.join(temporary, packages[0]), archive);
  const archiveChecksum = `${archive}.sha256`;
  await writeFile(
    archiveChecksum,
    `${sha256(await readFile(archive))}  ${path.basename(archive)}\n`
  );
  await copyFile(
    path.join(temporary, "PKGBUILD"),
    path.join(output, "PKGBUILD")
  );
  // Ensure makepkg preserved every original binary/resource byte and mode.
  const original = path.join(temporary, "original");
  const packaged = path.join(temporary, "packaged");
  await mkdir(original);
  await mkdir(packaged);
  const member = path.join(temporary, data[0]);
  run("bsdtar", ["-xf", deb, "-C", temporary, data[0]]);
  run("bsdtar", ["-xf", member, "-C", original]);
  run("bsdtar", ["-xf", archive, "-C", packaged]);
  const originalFiles = await payloadFiles(path.join(original, "usr"));
  const packagedFiles = new Map(
    (await payloadFiles(path.join(packaged, "usr"))).map((file) => [
      file.path,
      file,
    ])
  );
  for (const file of originalFiles)
    assert.deepEqual(
      packagedFiles.get(file.path),
      file,
      `Arch package modified ${file.path}`
    );
  run("pacman", ["-U", "--noconfirm", archive], { stdio: "inherit" });
  for (const file of originalFiles)
    assert.equal(
      sha256(await readFile(path.join("/usr", file.path))),
      file.sha256,
      `Installed file mismatch: ${file.path}`
    );
  const compiler = settings.tools.tools.find((tool) => tool.name === "pawncc");
  const compilerPath = path.join(
    "/usr/lib/ompide/binaries",
    compiler.destination
  );
  const library = path.resolve(path.dirname(compilerPath), "../lib");
  for (const executable of ["/usr/bin/ompide", compilerPath])
    assert.ok(
      !run("ldd", [executable], {
        env: { ...process.env, LD_LIBRARY_PATH: library },
      }).includes("not found")
    );
  assert.equal(
    run("/usr/bin/pawnlsp", ["--version"]).trim(),
    settings.tools.tools.find((tool) => tool.name === "pawnlsp").version
  );
  // -h can intentionally return a nonzero exit code; validate the banner.
  let banner;
  try {
    banner = run(compilerPath, ["-h"], {
      env: { ...process.env, LD_LIBRARY_PATH: library },
    });
  } catch (error) {
    if (typeof error.status !== "number") throw error;
    banner = error.stdout;
  }
  assert.ok(
    banner.startsWith(`Pawn compiler ${compiler.version}`),
    "Installed compiler version mismatch"
  );
  run(
    "runuser",
    [
      "-u",
      "ompide-build",
      "--",
      "xvfb-run",
      "-a",
      process.execPath,
      path.join(projectRoot, "scripts/linux-smoke.mjs"),
    ],
    { stdio: "inherit" }
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `archive=${archive}\nchecksum=${archiveChecksum}\n`
    );
  console.log(`Verified Arch package: ${archive}`);
} finally {
  await removeTemporary(temporary, output, ".arch-package-");
}
