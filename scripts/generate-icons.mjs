import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "assets/branding/ompide.png");
const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
const temporaryRoot = path.join(root, "test-results");
const desktopIcons = path.join(root, "src-tauri/icons");
const webIcons = path.join(root, "public/branding");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
await mkdir(temporaryRoot, { recursive: true });
const staging = await mkdtemp(path.join(temporaryRoot, "icon-generation-"));

function generate(output, options = []) {
  execFileSync(
    process.execPath,
    [cli, "icon", source, "--output", output, ...options],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    }
  );
}

async function removeStaging() {
  const absolute = await realpath(staging);
  const parent = await realpath(temporaryRoot);
  if (
    path.dirname(absolute) !== parent ||
    !path.basename(absolute).startsWith("icon-generation-")
  ) {
    throw new Error("Refusing to remove an unexpected icon staging directory");
  }
  await rm(absolute, { recursive: true, force: true });
}

try {
  const desktop = path.join(staging, "desktop");
  const web = path.join(staging, "web");
  generate(desktop);
  generate(
    web,
    sizes.flatMap((size) => ["--png", String(size)])
  );
  await mkdir(desktopIcons, { recursive: true });
  await mkdir(webIcons, { recursive: true });
  for (const entry of await readdir(desktop, { withFileTypes: true })) {
    if (entry.isFile() && /\.(png|ico|icns)$/.test(entry.name)) {
      await copyFile(
        path.join(desktop, entry.name),
        path.join(desktopIcons, entry.name)
      );
    }
  }
  for (const size of sizes) {
    await copyFile(
      path.join(web, `${size}x${size}.png`),
      path.join(webIcons, `ompide-${size}.png`)
    );
  }
  await copyFile(
    path.join(desktopIcons, "icon.ico"),
    path.join(root, "public/favicon.ico")
  );
  console.log(
    "Updated desktop/installer icons, favicon and 16–1024 px branding images."
  );
} finally {
  await removeStaging();
}
