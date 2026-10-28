// Explicit developer preparation. Neither app startup nor opening a workspace calls this script.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await readFile(path.join(root, 'toolchain/fixtures.json'), 'utf8'));
const archive = path.join(root, `.tools-cache/omp-stdlib-${pin.commit}.zip`);
const destination = path.join(root, 'fixtures/openmp/.vendor/omp-stdlib');
await mkdir(path.dirname(archive), { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes) {
  if (!process.argv.includes('--download')) throw new Error(`Missing cached source archive. Place it at ${archive}, or run ${process.platform === 'win32' ? 'npm.cmd' : 'npm'} run fixtures:prepare -- --download. Source: ${pin.url}`);
  console.log(`Downloading pinned fixture includes: ${pin.url}`);
  const response = await fetch(pin.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Fixture archive checksum mismatch');
await writeFile(archive, bytes);
const staging = await mkdtemp(path.join(tmpdir(), 'pawn-fixture-'));
try {
  const prefix = `omp-stdlib-${pin.commit}`;
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  if (entries.some(entry => { const normalized = entry.replaceAll('\\', '/'); return !normalized.startsWith(`${prefix}/`) || normalized.split('/').includes('..'); })) throw new Error('Unsafe fixture archive path');
  execFileSync('tar', ['-xf', archive, '-C', staging]);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(path.join(staging, prefix))) if (entry.endsWith('.inc') || entry === 'license.md') await copyFile(path.join(staging, prefix, entry), path.join(destination, entry));
  console.log(`Prepared real open.mp includes at ${destination}; commit ${pin.commit}; ${pin.license}`);
} finally { await rm(staging, { recursive: true, force: true }); }
