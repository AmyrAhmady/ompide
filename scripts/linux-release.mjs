// Linux-only assembly and verification, run by CI after Tauri builds the .deb.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { applicationNotices } from "./release-notices.mjs";
import {
  cargoExecutable,
  projectRoot,
  releaseSettings,
  removeTemporary,
  sha256,
} from "./release-support.mjs";
import { compilerEnvironment } from "./toolchain-target.mjs";
import { localBuildMatches } from "./lsp-build-record.mjs";

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Run Linux packaging on the Linux x64 CI runner");
const settings = await releaseSettings();
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120000,
    ...options,
  });

if (process.argv[2] === "notices") {
  await applicationNotices(
    path.join(projectRoot, "src-tauri/licenses/dependencies"),
    settings.target
  );
  await copyFile(
    path.join(projectRoot, "src/editor/pawn/LICENSE.txt"),
    path.join(projectRoot, "src-tauri/licenses/pawn-grammar.txt")
  );
} else if (process.argv[2] === "package") {
  const executable = await cargoExecutable({
    profile: "release",
    target: settings.target,
  });
  const bundle = path.join(path.dirname(executable), "bundle/deb");
  const packages = (await readdir(bundle)).filter((file) =>
    file.endsWith(".deb")
  );
  assert.equal(packages.length, 1, "Expected exactly one Tauri Debian package");
  const deb = path.join(bundle, packages[0]);
  assert.equal(
    run("dpkg-deb", ["--field", deb, "Version"]).trim(),
    settings.version
  );
  assert.equal(
    run("dpkg-deb", ["--field", deb, "Architecture"]).trim(),
    "amd64"
  );
  const output = path.join(projectRoot, "release");
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(path.join(output, ".linux-package-"));
  try {
    const extracted = path.join(temporary, "extracted");
    run("dpkg-deb", ["--extract", deb, extracted]);
    const resources = path.join(extracted, "usr/lib/ompide");
    const server = settings.tools.tools.find((tool) => tool.name === "pawnlsp");
    const compiler = settings.tools.tools.find(
      (tool) => tool.name === "pawncc"
    );
    const serverPath = path.join(extracted, "usr/bin/pawnlsp");
    const compilerPath = path.join(resources, "binaries", compiler.destination);
    assert.equal(
      sha256(await readFile(compilerPath)),
      compiler.executableSha256
    );
    for (const file of compiler.companions)
      assert.equal(
        sha256(
          await readFile(path.join(resources, "binaries", file.destination))
        ),
        file.sha256
      );
    const record = JSON.parse(
      await readFile(
        path.join(resources, "binaries/licenses/pawnlsp-dependencies.json"),
        "utf8"
      )
    );
    const pin = JSON.parse(
      await readFile(
        path.join(projectRoot, "toolchain/pawnlsp-build.json"),
        "utf8"
      )
    );
    assert.ok(
      localBuildMatches(
        record,
        pin,
        server,
        sha256(await readFile(serverPath)),
        true,
        "linux/amd64"
      ),
      "Packaged LSP provenance mismatch"
    );
    for (const file of [
      path.join(extracted, "usr/bin/ompide"),
      compilerPath,
      path.join(resources, "binaries", compiler.companions[0].destination),
    ]) {
      const libraries = run("ldd", [file], {
        env: compilerEnvironment(compilerPath),
      });
      assert.ok(
        !libraries.includes("not found"),
        `Missing libraries for ${file}: ${libraries}`
      );
    }
    const tools = path.join(temporary, "tools");
    await mkdir(tools);
    await copyFile(serverPath, path.join(tools, "pawnlsp"));
    await cp(path.join(resources, "binaries"), path.join(tools, "binaries"), {
      recursive: true,
    });
    run(process.execPath, ["scripts/verify-tools.mjs", "--package", tools], {
      stdio: "inherit",
    });
    const files = path.join(temporary, "files");
    await mkdir(files);
    await copyFile(deb, path.join(files, packages[0]));
    await copyFile(
      path.join(projectRoot, "LICENSE"),
      path.join(files, "LICENSE")
    );
    const readme = await readFile(
      path.join(projectRoot, "packaging/linux/README.txt"),
      "utf8"
    );
    await writeFile(
      path.join(files, "README.txt"),
      readme.replaceAll("{version}", settings.version)
    );
    const manifest = {
      version: settings.version,
      target: settings.target,
      sourceCommit: run("git", ["rev-parse", "HEAD"]).trim(),
      pawnlsp: record,
      files: [],
    };
    for (const name of await readdir(files)) {
      const bytes = await readFile(path.join(files, name));
      manifest.files.push({
        path: name,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    await writeFile(
      path.join(files, "release-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n"
    );
    const archive = path.join(
      output,
      `ompide-${settings.version}-linux-x64.zip`
    );
    await rm(archive, { force: true });
    run("zip", [
      "-j",
      archive,
      ...(await readdir(files)).map((file) => path.join(files, file)),
    ]);
    const checksum = `${archive}.sha256`;
    await writeFile(
      checksum,
      `${sha256(await readFile(archive))}  ${path.basename(archive)}\n`
    );
    run("unzip", ["-t", archive]);
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `archive=${archive}\nchecksum=${checksum}\ndeb=${deb}\n`
      );
    console.log(`Verified Linux package: ${archive}`);
  } finally {
    await removeTemporary(temporary, output, ".linux-package-");
  }
} else throw new Error("Usage: node scripts/linux-release.mjs notices|package");
