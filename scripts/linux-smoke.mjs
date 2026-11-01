import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "linux")
  throw new Error("Linux startup check must run on Linux");
const directory = await mkdtemp(path.join(tmpdir(), "ompide-installed-"));
const child = spawn("/usr/bin/ompide", [], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    XDG_CONFIG_HOME: directory,
    XDG_DATA_HOME: directory,
    XDG_CACHE_HOME: directory,
  },
});
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
const closed = new Promise((resolve) => child.once("close", resolve));

function stopGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

try {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    setTimeout(resolve, 7000);
  });
  assert.equal(child.exitCode, null, `Installed app exited early: ${output}`);
  assert.equal(child.signalCode, null, `Installed app terminated: ${output}`);
  const windows = execFileSync("xwininfo", ["-root", "-tree"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.match(
    windows,
    /ompide/i,
    `No native application window: ${output}\n${windows}`
  );
  console.log(
    "Installed Linux package opened a native ompide window under Xvfb."
  );
} finally {
  stopGroup("SIGTERM");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  stopGroup("SIGKILL");
  await closed;
  await rm(directory, { recursive: true, force: true });
  console.log(output);
}
