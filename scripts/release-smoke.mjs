import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  projectRoot,
  releaseSettings,
  removeTemporary,
  sha256,
  verifyPackage,
} from "./release-support.mjs";

const settings = await releaseSettings();
const otherInstances = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "@(Get-Process -Name ompide -ErrorAction SilentlyContinue).Count",
  ],
  { encoding: "utf8", windowsHide: true }
);
if (Number(otherInstances.trim()) > 0)
  throw new Error(
    "Close other ompide instances before the release smoke test; it backs up and restores application preferences."
  );
const archive = path.join(
  projectRoot,
  `release/ompide-${settings.version}-windows-x64.zip`
);
const checksum = (await readFile(`${archive}.sha256`, "utf8")).split(/\s+/)[0];
if (sha256(await readFile(archive)) !== checksum)
  throw new Error("Release ZIP checksum mismatch");
const temporaryRoot = tmpdir();
const temporary = await mkdtemp(
  path.join(temporaryRoot, "ompide-release-smoke-")
);
let application;
let startupOutput = "";
try {
  const directory = path.join(temporary, "app");
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
  if (manifest.profile !== "release")
    throw new Error("The desktop smoke requires the release ZIP");
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const profile = path.join(temporary, "webview-profile");
  await mkdir(profile);
  application = spawn(path.join(directory, "ompide.exe"), [], {
    cwd: directory,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  application.on("error", (error) => {
    startupOutput += error.message;
  });
  const record = (chunk) => {
    startupOutput = (startupOutput + chunk.toString()).slice(-16384);
  };
  application.stdout.on("data", record);
  application.stderr.on("data", record);
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && application.exitCode === null) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* WebView2 has not opened its test-only loopback endpoint yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error(
      `Release app did not start its WebView2 test endpoint: ${startupOutput}`
    );
  const previousDirectory = process.env.OMPIDE_PACKAGE_DIR;
  const previousEndpoint = process.env.OMPIDE_CDP_URL;
  process.env.OMPIDE_PACKAGE_DIR = directory;
  process.env.OMPIDE_CDP_URL = endpoint;
  try {
    await import("./production-smoke.mjs");
  } finally {
    if (previousDirectory === undefined) delete process.env.OMPIDE_PACKAGE_DIR;
    else process.env.OMPIDE_PACKAGE_DIR = previousDirectory;
    if (previousEndpoint === undefined) delete process.env.OMPIDE_CDP_URL;
    else process.env.OMPIDE_CDP_URL = previousEndpoint;
  }
  console.log(
    "Release ZIP desktop smoke passed from an extracted folder outside the checkout."
  );
} finally {
  if (application?.pid && application.exitCode === null) {
    try {
      execFileSync(
        "taskkill.exe",
        ["/PID", String(application.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" }
      );
    } catch {
      /* The application may have exited while taskkill was starting. */
    }
  }
  await removeTemporary(temporary, temporaryRoot, "ompide-release-smoke-");
}
