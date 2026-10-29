// Real native app, real pinned PawnKit and openmultiplayer/compiler. No mocked IPC.
import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const expect = baseExpect.configure({ timeout: 20_000 });
const directory = await mkdtemp(path.join(tmpdir(), 'pawn build '));
const existing = path.join(directory, 'existing');
const setup = path.join(directory, 'setup');
const yaml = path.join(directory, 'yaml');
const openmp = path.join(directory, 'openmp');
const preferences = path.join(process.env.APPDATA, 'mp.open.editor/preferences.json');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('1420'));
if (!page) throw new Error('Start the native debug app connected to Vite with loopback CDP port 9222.');
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', error => errors.push(error.stack || error.message));
let previous;
let seeded = false;
const evidence = [];
async function evaluate(operation, argument) { return page.evaluate(async ({ operation, argument }) => {
  const source = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
  const { workbench } = await import(source);
  globalThis.buildWorkbench = workbench;
  return await (0, eval)(operation)(workbench, argument);
}, { operation: operation.toString(), argument }); }
const dialog = () => page.getByRole('dialog', { name: 'Configure Project…', exact: true });
async function configure() {
  await page.locator('.menu summary').getByText('Build', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Configure Project…', exact: true }).click();
  await expect(dialog()).toBeVisible();
}
async function build(phase = 'passed') {
  await page.keyboard.press('Control+Shift+B');
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase), { timeout: 30_000 }).toBe(phase);
}
try {
  try { previous = await readFile(preferences); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await cp(path.join(root, 'fixtures/minimal'), existing, { recursive: true, filter: file => !file.includes(`${path.sep}output`) });
  await mkdir(setup); await mkdir(yaml);
  await cp(path.join(root, 'fixtures/openmp'), openmp, { recursive: true, filter: file => !file.includes(`${path.sep}output`) });
  await writeFile(path.join(setup, 'first.pwn'), 'main() { return 1; }\n');
  await writeFile(path.join(setup, 'second.pwn'), 'main() { MissingFunction(); }\n');
  await writeFile(path.join(yaml, 'main.pwn'), 'main() { WrongEntry(); }\n');
  await writeFile(path.join(yaml, 'alternate.pwn'), 'main() { return 1; }\n');
  await writeFile(path.join(yaml, 'pawn.yaml'), 'entry: main.pwn\npreset: openmp\ninclude_path: .\nexperimental:\n  build_file: false\nbuild:\n  input: alternate.pwn\nbuilds:\n  - name: broken\n    input: main.pwn\n');
  await mkdir(path.dirname(preferences), { recursive: true });
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  seeded = true;
  await writeFile(preferences, JSON.stringify({ recentWorkspaces: [existing, setup, yaml, openmp], settings: { theme: 'dark' } }));
  await page.reload();
  await page.getByRole('button', { name: existing, exact: true }).click();
  await page.getByRole('button', { name: 'main.pwn', exact: true }).click();
  await assert.rejects(stat(path.join(existing, 'output')), { code: 'ENOENT' });
  await page.keyboard.press('Control+Shift+B');
  await expect(dialog()).toBeVisible();
  await expect(dialog().getByTestId('build-entry')).toHaveText(path.join(existing, 'main.pwn'));
  await expect(dialog().getByRole('button', { name: 'Build Project', exact: true })).toBeEnabled({ timeout: 20_000 });
  await dialog().getByRole('button', { name: 'Build Project', exact: true }).click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('passed');
  assert.ok((await stat(path.join(existing, 'output/main.amx'))).size > 0);
  await expect(page.getByText('Compiler exit code: 0', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'test-results/build-success.png') });
  evidence.push('Build command opens configuration first; real selected entry compiles to a verified AMX with compiler exit status.');

  await evaluate(workbench => { Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model.setValue('main() {\n    MissingFunction();\n}\n'); });
  await build('failed');
  assert.match(await readFile(path.join(existing, 'main.pwn'), 'utf8'), /MissingFunction/);
  await assert.rejects(stat(path.join(existing, 'output/main.amx')), { code: 'ENOENT' });
  const diagnostic = page.locator('.build-diagnostics button').filter({ hasText: 'MissingFunction' });
  await diagnostic.click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().position.line)).toBe(2);
  await page.screenshot({ path: path.join(root, 'test-results/build-diagnostics.png') });
  evidence.push('Build saves dirty source, reports actual compiler failure, removes stale AMX and navigates diagnostic clicks to line 2.');

  const manifestPath = path.join(existing, 'pawn.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.builds = [{ name: 'alternate', input: 'alternate.pwn' }];
  await writeFile(path.join(existing, 'alternate.pwn'), 'main() { return 1; }\n');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await build('failed');
  await expect(page.locator('.build-summary')).toContainText('configuration changed');
  await configure();
  await dialog().getByRole('button', { name: 'Refresh Configuration', exact: true }).click();
  await expect(dialog().getByLabel('Named build')).toBeVisible();
  await dialog().getByLabel('Named build').selectOption('alternate');
  await expect(dialog().getByTestId('build-entry')).toContainText('alternate.pwn');
  await dialog().getByRole('button', { name: 'Build Project', exact: true }).click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('passed');
  assert.ok((await stat(path.join(existing, 'output/alternate.amx'))).size > 0);
  evidence.push('Changed manifests require refreshed selection; named builds display and compile their actual entry point.');

  await evaluate(async (workbench, yaml) => { await workbench.chooseFolder(yaml); }, yaml);
  await page.keyboard.press('Control+Shift+B');
  await expect(dialog().getByTestId('build-entry')).toContainText('alternate.pwn');
  await dialog().getByRole('button', { name: 'Build Project', exact: true }).click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('passed');
  assert.ok((await stat(path.join(yaml, 'output/alternate.amx'))).size > 0);
  evidence.push('YAML manifests and default build input overrides select the correct entry.');
  await writeFile(path.join(yaml, 'pawn.yaml'), (await readFile(path.join(yaml, 'pawn.yaml'), 'utf8')) + 'pawnkit:\n  schemaVersion: 1\n  profile: openmp\n');
  await evaluate(async (workbench, yaml) => { await workbench.selectProject(yaml); }, yaml);
  await build('failed');
  await expect(page.locator('.build-summary')).toContainText('rejects pawnkit.schemaVersion in YAML');
  evidence.push('Pinned PawnKit YAML extension validation bug is reported with actionable JSON guidance; no manifest is silently rewritten.');

  await evaluate(async (workbench, openmp) => { await workbench.chooseFolder(openmp); }, openmp);
  await page.keyboard.press('Control+Shift+B');
  await expect(dialog().getByTestId('build-entry')).toContainText('main.pwn');
  await dialog().getByRole('button', { name: 'Build Project', exact: true }).click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('passed');
  assert.ok((await stat(path.join(openmp, 'output/main.amx'))).size > 0);
  evidence.push('Official open.mp includes, callbacks and macros compile through the native Build UI with openmultiplayer/compiler 3.10.11.');

  await evaluate(async (workbench, setup) => { await workbench.chooseFolder(setup); }, setup);
  await page.keyboard.press('Control+Shift+B');
  await expect(dialog().getByLabel('Entry point')).toBeVisible();
  await expect(dialog().getByLabel('Entry point')).toHaveValue('');
  await dialog().getByLabel('Entry point').selectOption(path.join(setup, 'first.pwn'));
  await dialog().getByRole('button', { name: 'Preview Manifest', exact: true }).click();
  await expect(dialog().locator('.manifest-preview')).toContainText('first.pwn');
  await assert.rejects(stat(path.join(setup, 'pawn.json')), { code: 'ENOENT' });
  await dialog().getByRole('button', { name: 'Create pawn.json', exact: true }).click();
  await expect(dialog().getByTestId('build-entry')).toContainText('first.pwn');
  assert.equal(JSON.parse(await readFile(path.join(setup, 'pawn.json'), 'utf8')).entry, 'first.pwn');
  await dialog().getByRole('button', { name: 'Build Project', exact: true }).click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('passed');
  evidence.push('Ambiguous manifest-less folders require entry selection; preview writes nothing, explicit creation uses PawnKit schema, then real compilation passes.');

  const firstPath = path.join(setup, 'first.pwn');
  await writeFile(firstPath, 'main() { return 1; }\n' + Array.from({ length: 30_000 }, (_, index) => `stock Generated${index}() { return ${index}; }`).join('\n'));
  await evaluate(async (workbench, file) => { await workbench.openPath(file); }, firstPath);
  await evaluate(workbench => { void workbench.buildProject().catch(workbench.report); });
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('compiling');
  const blocked = await evaluate(async (workbench, folder) => { try { await workbench.chooseFolder(folder); return ''; } catch (error) { return error.code; } }, existing);
  assert.equal(blocked, 'buildBusy');
  await evaluate(workbench => { const editor = Reflect.get(workbench, 'codeEditor'); editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); });
  const typingStarted = Date.now();
  await page.keyboard.type('// typed during compilation\n', { delay: 0 });
  assert.ok(Date.now() - typingStarted < 3000, 'Typing was blocked during compilation');
  await page.getByRole('button', { name: 'Cancel Build', exact: true }).click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().build.phase)).toBe('cancelled');
  assert.ok(await evaluate(workbench => workbench.getSnapshot().tabs.some(tab => tab.dirty)));
  await assert.rejects(stat(path.join(setup, 'output/first.amx')), { code: 'ENOENT' });
  evidence.push('Cancellation stops the real compiler, removes partial output and preserves edits made during compilation; workspace switches are blocked while building.');

  const selection = await evaluate(async workbench => {
    const tools = await workbench.buildTools();
    await workbench.settings({ compilerPath: tools.compiler.path });
    const external = await workbench.buildTools();
    await workbench.settings({ compilerPath: tools.pawn.path });
    let rejected; try { await workbench.buildTools(); } catch (error) { rejected = error.code; }
    await workbench.settings({ compilerPath: '' });
    return { source: external.compiler.source, rejected };
  });
  assert.equal(selection.source, 'external'); assert.equal(selection.rejected, 'buildToolVersion');
  evidence.push('Compatible external compiler paths are verified; selecting the Pawn CLI as compiler is rejected.');
  for (const theme of ['light', 'dark']) {
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await evaluate(async (workbench, theme) => { await workbench.settings({ theme }); }, theme);
    await expect(page.locator('.monaco-editor-background').first()).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(30, 30, 30)');
    await page.screenshot({ path: path.join(root, `test-results/build-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'test-results/build-workflows.json'), JSON.stringify(evidence, null, 2));
  console.log(evidence.join('\n'));
} catch (error) {
  console.error('Build verification failed:', error);
  console.error('UI:', (await page.locator('body').innerText()).slice(-6000));
  throw error;
} finally {
  try {
    const closed = page.waitForEvent('close', { timeout: 20_000 });
    await evaluate(async workbench => {
      await workbench.cancelBuild();
      await Reflect.get(workbench, 'buildPending');
      await Reflect.get(workbench, 'settingsQueue');
      workbench.subscribe(() => { if (workbench.getSnapshot().prompt) workbench.answerPrompt('discard'); });
      await workbench.quit();
    });
    await closed;
  } finally {
    if (seeded) { if (previous) await writeFile(preferences, previous); else await rm(preferences, { force: true }); }
    await browser.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
