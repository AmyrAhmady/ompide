import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { listFiles, projectRoot, sha256 } from "./release-support.mjs";

const legalName =
  /^(licen[cs]e|copying|notice|copyright|third[-_ ]?party.*notices)(?:$|[._ -])/i;
const legalDirectory = /^(licenses?|legal|notices)$/i;

export function npmPackages(
  options,
  environment = process.env,
  run = execFileSync
) {
  const args = ["query", ":not(.dev)", "--json"];
  const output = environment.npm_execpath
    ? run(process.execPath, [environment.npm_execpath, ...args], options)
    : process.platform === "win32"
      ? // cmd is needed for npm.cmd shims. The command is fixed and contains no user input.
        run(
          environment.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", 'npm.cmd query ":not(.dev)" --json'],
          { ...options, windowsVerbatimArguments: true }
        )
      : run("npm", args, options);
  return JSON.parse(output);
}

export async function copyPackageNotices(
  directory,
  destination,
  information,
  licenseFile
) {
  const selected = new Set();
  for (const base of ["", "vscode"]) {
    let entries;
    try {
      entries = await readdir(path.join(directory, base), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const relative = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isFile() && legalName.test(entry.name)) selected.add(relative);
      if (entry.isDirectory() && legalDirectory.test(entry.name)) {
        for (const file of await listFiles(path.join(directory, relative)))
          selected.add(`${relative}/${file}`);
      }
    }
  }
  if (licenseFile) {
    const relative = path.relative(
      directory,
      path.resolve(directory, licenseFile)
    );
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Dependency license points outside its package");
    if ((await stat(path.join(directory, relative))).isFile())
      selected.add(relative.replaceAll("\\", "/"));
  }
  const identifier =
    `${information.ecosystem}/${information.name}@${information.version}`
      .replaceAll("/", "__")
      .replace(/[^a-zA-Z0-9@._-]/g, "_");
  const notices = [];
  const sourceRoot = await realpath(directory);
  for (const file of [...selected].sort()) {
    const source = await realpath(path.join(directory, file));
    const relative = path.relative(sourceRoot, source);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Dependency license points outside its package");
    const target = path.join(destination, identifier, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    // Go's module cache is read-only. Generated copies must remain replaceable
    // when Tauri refreshes resources during the next incremental build.
    await chmod(target, 0o644);
    notices.push(`${identifier}/${file}`);
  }
  return { ...information, notices };
}

export async function applicationNotices(destination, target) {
  // A few published packages omit the license files from their source repository.
  // Keep version-specific copies locally so packaging never fetches legal files.
  const supplemental = path.join(projectRoot, "packaging/licenses");
  const sources = JSON.parse(
    await readFile(path.join(supplemental, "sources.json"), "utf8")
  );
  for (const source of sources) {
    if (path.basename(source.file) !== source.file)
      throw new Error("Invalid supplemental license filename");
    const bytes = await readFile(path.join(supplemental, source.file));
    if (sha256(bytes) !== source.sha256)
      throw new Error(`Supplemental license checksum mismatch: ${source.file}`);
    await mkdir(path.join(destination, "supplemental"), { recursive: true });
    await copyFile(
      path.join(supplemental, source.file),
      path.join(destination, "supplemental", source.file)
    );
  }
  await copyFile(
    path.join(supplemental, "sources.json"),
    path.join(destination, "supplemental/sources.json")
  );
  const options = {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  };
  const packages = npmPackages(options);
  const inventory = [];
  const seen = new Set();
  for (const pkg of packages) {
    if (!pkg.location?.startsWith("node_modules/")) continue;
    const directory = path.join(projectRoot, pkg.location);
    const metadata = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8")
    );
    const identifier = `npm:${metadata.name}@${metadata.version}`;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    inventory.push(
      await copyPackageNotices(directory, destination, {
        ecosystem: "npm",
        name: metadata.name,
        version: metadata.version,
        license: metadata.license ?? null,
      })
    );
  }
  const cargo = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--locked",
        "--offline",
        "--features",
        "tauri/custom-protocol",
        "--filter-platform",
        target,
        "--format-version",
        "1",
      ],
      options
    )
  );
  const reachable = new Set();
  const nodes = new Map(cargo.resolve.nodes.map((node) => [node.id, node]));
  const visit = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (
        dependency.dep_kinds.some(
          (kind) => kind.kind === null || kind.kind === "build"
        )
      )
        visit(dependency.pkg);
    }
  };
  visit(cargo.resolve.root);
  for (const pkg of cargo.packages) {
    if (!pkg.source || !reachable.has(pkg.id)) continue;
    inventory.push(
      await copyPackageNotices(
        path.dirname(pkg.manifest_path),
        destination,
        {
          ecosystem: "cargo",
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
        },
        pkg.license_file
      )
    );
  }
  for (const dependency of inventory) {
    const { ecosystem, name, version } = dependency;
    let extra = [];
    if (
      ecosystem === "npm" &&
      name.startsWith("@codingame/monaco-vscode-") &&
      version === "37.6.0"
    ) {
      extra = ["codingame.txt", "vscode.txt", "vscode-third-party.txt"];
    } else if (ecosystem === "cargo") {
      const overrides = {
        "alloc-stdlib@0.3.0": ["alloc-stdlib.txt"],
        "selectors@0.38.0": ["mpl-2.0.txt"],
        "tauri-plugin@2.7.2": ["tauri-mit.txt", "tauri-apache.txt"],
        "webview2-com@0.39.1": ["webview2-com.txt"],
        "webview2-com-sys@0.39.1": ["webview2-com.txt"],
        "webview2-com-macros@0.8.1": ["webview2-com-macros.txt"],
      };
      extra = overrides[`${name}@${version}`] ?? [];
    }
    dependency.notices.push(...extra.map((file) => `supplemental/${file}`));
    if (!dependency.notices.length)
      throw new Error(
        `Missing published license text for ${ecosystem}:${name}@${version}`
      );
  }
  await writeFile(
    path.join(destination, "dependencies.json"),
    JSON.stringify(inventory, null, 2) + "\n"
  );
  console.log(
    `Included published dependency notices and license metadata for ${inventory.length} npm/Rust packages.`
  );
}
