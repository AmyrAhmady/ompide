// Explicit development/release preparation only; never called by workspace open or app startup.
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'toolchain/tools.json'), 'utf8'));
const download = process.argv.includes('--download');
const cache = path.join(root, '.tools-cache');
const binaries = path.join(root, 'src-tauri/binaries');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`Only verified target ${manifest.target} is currently supported.`);
}
await mkdir(cache, { recursive: true });
await mkdir(binaries, { recursive: true });
const sha256 = data => createHash('sha256').update(data).digest('hex');
for (const tool of manifest.tools) {
  if (tool.sourceBuild) {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-pawnlsp.mjs'), ...(download ? ['--download'] : [])], { cwd: root, stdio: 'inherit', windowsHide: true });
    continue;
  }
  const archive = path.join(cache, path.basename(new URL(tool.url).pathname));
  let bytes;
  try { bytes = await readFile(archive); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    if (!download) throw new Error(`Missing ${archive}. Place the pinned archive there manually, or run npm.cmd run tools:prepare -- --download. Source: ${tool.url}`);
    console.log(`Downloading ${tool.name} ${tool.version}: ${tool.url}`);
    const response = await fetch(tool.url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${tool.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== tool.sha256) throw new Error(`Archive checksum mismatch: ${tool.name}`);
    await writeFile(archive, bytes);
  }
  if (sha256(bytes) !== tool.sha256) throw new Error(`Archive checksum mismatch: ${archive}`);
  const staging = await mkdtemp(path.join(tmpdir(), 'pawn-tools-'));
  try {
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    if (entries.some(entry => { const normalized = entry.replaceAll('\\', '/'); return path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..'); })) {
      throw new Error(`Unsafe archive path: ${tool.name}`);
    }
    execFileSync('tar', ['-xf', archive, '-C', staging]);
    const executable = path.join(staging, tool.executable);
    const executableHash = sha256(await readFile(executable));
    if (tool.executableSha256 && executableHash !== tool.executableSha256) {
      throw new Error(`Executable checksum mismatch: ${tool.name}`);
    }
    const destination = path.join(binaries, tool.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    if (tool.name === 'pawncc') {
      // The pinned distribution requires pawnc.dll next to pawncc.exe.
      await copyFile(executable, destination);
      await copyFile(path.join(path.dirname(executable), 'pawnc.dll'), path.join(path.dirname(destination), 'pawnc.dll'));
    } else {
      await copyFile(executable, destination);
    }
    console.log(`Verified ${tool.name} ${tool.version}: ${tool.destination} (sha256:${executableHash})`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
await cp(path.join(root, 'toolchain/licenses'), path.join(binaries, 'licenses'), { recursive: true });
