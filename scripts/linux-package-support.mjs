import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listFiles, sha256 } from "./release-support.mjs";

export async function payloadFiles(directory) {
  const files = [];
  for (const name of await listFiles(directory)) {
    if (name === "release-manifest.json") continue;
    const file = path.join(directory, name);
    const bytes = await readFile(file);
    files.push({
      path: name,
      size: bytes.length,
      sha256: sha256(bytes),
      mode: (await stat(file)).mode & 0o777,
    });
  }
  return files;
}

export async function verifyPayloadFiles(directory, expected) {
  assert.deepEqual(
    await payloadFiles(directory),
    expected,
    "Extracted payload content or permissions changed"
  );
}
