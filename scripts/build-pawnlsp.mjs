// Explicit developer/release preparation. The application never invokes this script.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.tools-cache');
const pin = JSON.parse(await readFile(path.join(root, 'toolchain/pawnlsp-build.json'), 'utf8'));
const tools = JSON.parse(await readFile(path.join(root, 'toolchain/tools.json'), 'utf8'));
const tool = tools.tools.find(tool => tool.name === 'pawnlsp');
const destination = path.join(root, 'src-tauri/binaries', tool.destination);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const download = process.argv.includes('--download');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This server build is verified only for Windows x64.');
if (!process.argv.includes('--rebuild')) {
  try {
    if (sha256(await readFile(destination)) === tool.executableSha256) {
      console.log(`Verified cached pawnlsp ${pin.version}`);
      process.exit(0);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(cache, { recursive: true });
const archive = path.join(cache, pin.source.archive);
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes) {
  if (!download) throw new Error(`Missing ${archive}. Supply the pinned archive manually or explicitly run tools:build-lsp with --download. Source: ${pin.source.url}`);
  console.log(`Downloading pinned PawnKit source: ${pin.source.url}`);
  const response = await fetch(pin.source.url);
  if (!response.ok) throw new Error(`Source download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.source.sha256) throw new Error('Source archive checksum mismatch');
  await writeFile(archive, bytes);
}
if (sha256(bytes) !== pin.source.sha256) throw new Error('Source archive checksum mismatch');
const patch = path.join(root, 'toolchain', pin.patch.path);
if (sha256(await readFile(patch)) !== pin.patch.sha256) throw new Error('Source patch checksum mismatch');
const go = process.env.OMPIDE_GO || path.join(cache, 'go1.26.5/bin/go.exe');
if (!process.env.OMPIDE_GO && sha256(await readFile(go)) !== pin.developmentGoDistribution.executableSha256) throw new Error('Cached Go executable checksum mismatch');
const environment = {
  ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOTELEMETRY: 'off',
  GOPROXY: download ? 'direct' : 'off', GOSUMDB: download ? 'sum.golang.org' : 'off',
  GOPATH: path.join(cache, 'go-work'), GOMODCACHE: path.join(cache, 'go-modules'), GOCACHE: path.join(cache, 'go-build'),
  GOOS: 'windows', GOARCH: 'amd64', GOFLAGS: '', GOWORK: 'off',
};
if (!execFileSync(go, ['version'], { encoding: 'utf8', env: environment, windowsHide: true }).startsWith(`go version ${pin.goVersion} windows/amd64`)) throw new Error(`Build requires ${pin.goVersion} Windows x64. Set OMPIDE_GO to its go.exe; Go is not downloaded automatically.`);
const staging = await mkdtemp(path.join(cache, 'pawnlsp-build-'));
try {
  const prefix = `pawnlsp-${pin.source.commit}`;
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  if (entries.some(entry => !entry.startsWith(`${prefix}/`) || entry.replaceAll('\\', '/').split('/').includes('..'))) throw new Error('Unsafe source archive path');
  execFileSync('tar', ['-xf', archive, '-C', staging], { windowsHide: true });
  const source = path.join(staging, prefix);
  const directory = path.relative(root, source).replaceAll('\\', '/');
  execFileSync('git', ['apply', '--check', `--directory=${directory}`, patch], { cwd: root, windowsHide: true });
  execFileSync('git', ['apply', `--directory=${directory}`, patch], { cwd: root, windowsHide: true });
  const runGo = args => execFileSync(go, args, { cwd: source, env: environment, stdio: 'inherit', windowsHide: true });
  if (download) runGo(['mod', 'download', ...pin.dependencyMirrors.map(dep => `${dep.mirror}@${dep.version}`)]);
  // Authenticate the official GitHub mirror trees against the original, canonical Go module sums.
  for (const dependency of pin.dependencyMirrors) {
    const directory = path.join(environment.GOMODCACHE, `${dependency.mirror}@${dependency.version}`);
    const files = [];
    const walk = async relative => {
      for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) files.push(file);
        else throw new Error('Unexpected dependency link');
      }
    };
    await walk('');
    const hash = createHash('sha256');
    for (const file of files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) hash.update(`${sha256(await readFile(path.join(directory, file)))}  ${dependency.module}@${dependency.version}/${file}\n`);
    if (`h1:${hash.digest('base64')}` !== dependency.canonicalChecksum) throw new Error(`Canonical dependency checksum mismatch: ${dependency.module}`);
  }
  runGo(['test', '-mod=readonly', './...']);
  const executable = path.join(staging, 'pawnlsp.exe');
  runGo(['build', '-mod=readonly', '-trimpath', '-buildvcs=false', `-ldflags=-s -w -buildid= -X main.version=${pin.version}`, '-o', executable, './cmd/pawnlsp']);
  const builtHash = sha256(await readFile(executable));
  if (builtHash !== tool.executableSha256) {
    await copyFile(executable, path.join(cache, 'pawnlsp-reproduction.exe'));
    throw new Error(`Built server checksum ${builtHash} differs from the pinned artifact ${tool.executableSha256}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(executable, destination);
  console.log(`Verified pawnlsp ${pin.version}: ${tool.executableSha256}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
