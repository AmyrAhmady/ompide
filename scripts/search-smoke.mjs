// Uses the real desktop application's scoped search commands and Monaco models.
import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const expect = baseExpect.configure({ timeout: 15_000 });
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'pawn search '));
const preferences = path.join(process.env.APPDATA, 'mp.open.editor/preferences.json');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('1420'));
if (!page) throw new Error('Start the native debug app connected to Vite with loopback CDP port 9222.');
page.setDefaultTimeout(15_000);
const errors = []; page.on('pageerror', error => errors.push(error.stack || error.message));
let previous; let seeded = false;
async function evaluate(operation, argument) { return page.evaluate(async ({ operation, argument }) => {
  const source = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
  const { workbench } = await import(source); globalThis.searchWorkbench = workbench;
  return await (0, eval)(operation)(workbench, argument);
}, { operation: operation.toString(), argument }); }
const preview = () => page.getByRole('dialog', { name: 'Preview Workspace Replacement', exact: true });
const summary = () => page.locator('.workspace-search [role="status"]');
const previewButton = () => page.getByRole('button', { name: 'Preview Replace All…', exact: true });
const evidence = [];
try {
  try { previous = await readFile(preferences); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await cp(path.join(root, 'fixtures/minimal'), directory, { recursive: true, filter: file => !file.includes(`${path.sep}output`) });
  const mainPath = path.join(directory, 'main.pwn');
  await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '// needle\n');
  const unicode = path.join(directory, 'unicode.inc'); const closed = path.join(directory, 'closed.inc');
  const original = Buffer.from('\ufeff// 🦀 needle\r\n// Needle\r\n', 'utf8');
  await writeFile(unicode, original); await writeFile(closed, '// needle in unopened file\n');
  await mkdir(path.join(directory, 'ignored')); await writeFile(path.join(directory, 'ignored/secret.inc'), '// needle ignored\n');
  await writeFile(path.join(directory, '.gitignore'), 'ignored/\n'); await writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 255, 1]));
  await mkdir(path.dirname(preferences), { recursive: true }); seeded = true;
  await writeFile(preferences, JSON.stringify({ recentWorkspaces: [directory], settings: { theme: 'dark' } }));
  await page.reload(); await page.getByRole('button', { name: directory, exact: true }).click();
  await page.keyboard.press('Control+Shift+f');
  await page.getByLabel('Search text', { exact: true }).fill('needle');
  await expect(summary()).toHaveText('Matches: 4 · Files: 3');
  await expect(page.locator('.search-results')).not.toContainText('secret.inc');
  await page.locator('.search-results button[title="unicode.inc:1:7"]').click();
  await expect.poll(() => evaluate(workbench => workbench.getSnapshot().position)).toEqual({ line: 1, column: 7 });
  evidence.push('Real workspace content search respects ignore rules and navigates Unicode/UTF-16 positions correctly.');

  await evaluate(workbench => {
    const model = Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model;
    const end = model.getFullModelRange().getEndPosition();
    model.pushEditOperations([], [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: '// unsaved needle\r\n' }], () => null);
  });
  await page.getByRole('button', { name: 'Refresh Search', exact: true }).click();
  await expect(summary()).toHaveText('Matches: 5 · Files: 3');
  await page.getByLabel('File path contains…', { exact: true }).fill('unicode.inc');
  await expect(summary()).toHaveText('Matches: 3 · Files: 1');
  await expect(page.locator('.search-file')).toContainText('unsaved');
  await page.getByLabel('Replace with…', { exact: true }).fill('$literal');
  await previewButton().click();
  await expect(preview()).toBeVisible();
  await expect(preview().locator('.monaco-diff-editor')).toBeVisible();
  await expect.poll(async () => (await preview().locator('.view-lines').allTextContents()).join('\n')).toContain('$literal');
  assert.deepEqual(await readFile(unicode), original);
  await preview().getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(await evaluate(workbench => Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model.getValue().includes('unsaved needle')));
  await previewButton().click(); await preview().getByRole('button', { name: 'Apply to Editor Buffers', exact: true }).click();
  await expect(preview()).toHaveCount(0);
  assert.deepEqual(await readFile(unicode), original);
  const replaced = await evaluate(workbench => Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model.getValue());
  assert.match(replaced, /unsaved \$literal/); assert.doesNotMatch(replaced, /needle/i);
  await page.locator('.menu summary').getByText('Edit', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Undo Ctrl+Z', exact: true }).click();
  assert.match(await evaluate(workbench => Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model.getValue()), /unsaved needle/);
  await previewButton().click(); await preview().getByRole('button', { name: 'Apply to Editor Buffers', exact: true }).click();
  await expect(preview()).toHaveCount(0); await page.keyboard.press('Control+Alt+s');
  await expect.poll(async () => (await readFile(unicode, 'utf8')).includes('unsaved $literal')).toBe(true);
  const saved = await readFile(unicode); assert.equal(saved.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.ok(saved.toString('utf8').split('\n').slice(0, -1).every(line => line.endsWith('\r')));
  evidence.push('Replacement diff preview/cancel never writes disk; applying uses dirty buffers, supports Undo, preserves BOM/CRLF and writes only on Save All.');

  await page.getByLabel('Search text', { exact: true }).fill('$literal');
  await page.getByLabel('Replace with…', { exact: true }).fill('updated');
  await expect(summary()).toHaveText('Matches: 3 · Files: 1');
  await previewButton().click(); await expect(preview()).toBeVisible();
  await evaluate(workbench => {
    const model = Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model;
    model.pushEditOperations([], [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '// changed after preview\r\n' }], () => null);
  });
  await preview().getByRole('button', { name: 'Apply to Editor Buffers', exact: true }).click();
  await expect(preview().locator('p[role="alert"]')).toContainText('changed after this replacement preview');
  assert.ok(await evaluate(workbench => Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active).model.getValue().includes('$literal')));
  await preview().getByRole('button', { name: 'Cancel', exact: true }).click();
  evidence.push('Edits made after a preview invalidate replacement application without overwriting the changed buffer.');

  const diskMain = await readFile(mainPath); const diskClosed = await readFile(closed);
  await page.getByLabel('File path contains…', { exact: true }).fill('');
  await page.getByLabel('Search text', { exact: true }).fill('needle');
  await page.getByLabel('Replace with…', { exact: true }).fill('across');
  await expect(summary()).toHaveText('Matches: 2 · Files: 2');
  await previewButton().click(); await preview().getByRole('button', { name: 'Apply to Editor Buffers', exact: true }).click();
  await expect(preview()).toHaveCount(0);
  assert.deepEqual(await readFile(mainPath), diskMain); assert.deepEqual(await readFile(closed), diskClosed);
  const tabs = await evaluate(workbench => workbench.getSnapshot().tabs);
  assert.ok(tabs.some(tab => tab.name === 'main.pwn' && tab.dirty)); assert.ok(tabs.some(tab => tab.name === 'closed.inc' && tab.dirty));
  await page.keyboard.press('Control+Alt+s');
  await expect.poll(async () => (await readFile(closed, 'utf8')).includes('across')).toBe(true);
  evidence.push('Multi-file replacements load unopened files into owned dirty tabs and keep disk unchanged until explicit Save All.');

  await evaluate(async workbench => { globalThis.diskPreview = await workbench.search({ query: 'across', fileQuery: 'closed.inc', matchCase: true, filesOnly: false }, 'external'); });
  await writeFile(closed, '// externally changed across\n');
  const staleDisk = await evaluate(async workbench => {
    try { await workbench.applyReplacements(globalThis.diskPreview, workbench.getSnapshot().root); return ''; }
    catch (error) { return error.code; }
  });
  assert.equal(staleDisk, 'searchChanged');
  assert.equal(await readFile(closed, 'utf8'), '// externally changed across\n');
  evidence.push('External disk changes invalidate replacement previews before any model replacement or disk write.');

  await page.keyboard.press('Control+p');
  const quick = page.getByRole('dialog', { name: 'Open File by Name…', exact: true });
  await quick.getByRole('combobox').fill('math.inc');
  await expect(quick.getByRole('option')).toHaveCount(1); await quick.getByRole('combobox').press('Enter');
  await expect(page.getByRole('tab', { name: 'math.inc', exact: true })).toHaveAttribute('aria-selected', 'true');
  evidence.push('Ctrl+P filters workspace paths and opens the selected file with keyboard navigation.');
  for (const theme of ['light', 'dark']) {
    await evaluate(async (workbench, theme) => { await workbench.settings({ theme }); }, theme);
    await expect(page.locator('.monaco-editor-background').first()).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(30, 30, 30)');
    await mkdir(path.join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: path.join(root, `test-results/search-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'test-results/search-workflows.json'), JSON.stringify(evidence, null, 2));
  console.log(evidence.join('\n'));
} catch (error) {
  console.error('Search verification failed:', error); console.error('Browser errors:', errors); console.error('UI:', (await page.locator('body').innerText()).slice(-3500)); throw error;
} finally {
  try {
    const closed = page.waitForEvent('close', { timeout: 20_000 });
    await evaluate(async workbench => {
      await workbench.cancelSearch(); await Reflect.get(workbench, 'settingsQueue');
      workbench.subscribe(() => { if (workbench.getSnapshot().prompt) workbench.answerPrompt('discard'); });
      await workbench.quit();
    });
    await closed;
  } finally {
    if (seeded) { if (previous) await writeFile(preferences, previous); else await rm(preferences, { force: true }); }
    await browser.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
