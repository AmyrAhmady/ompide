import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type CSSProperties } from 'react';
import { Uri } from 'monaco-editor';
import { workbench } from './app/workbench';
import { desktop, type Entry } from './lib/native';
import { t, type TranslationKey } from './lib/i18n';
import { defaultThemes, themeVariables } from './settings/theme';
import type { Settings } from './settings/settings';
import './App.css';

const run = (operation: () => Promise<unknown>) => { void operation().catch(workbench.report); };

function Modal({ children, label, onCancel }: { children: ReactNode; label: string; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} aria-label={label} onCancel={event => { event.preventDefault(); onCancel(); }}>{children}</dialog>;
}

function MenuItem({ label, shortcut, action, disabled = false }: { label: TranslationKey; shortcut?: string; action: () => void; disabled?: boolean }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={event => {
    event.currentTarget.closest('details')?.removeAttribute('open'); action();
  }}><span>{t(label)}</span><kbd>{shortcut}</kbd></button>;
}
function Menu({ label, children }: { label: TranslationKey; children: ReactNode }) {
  return <details className="menu"><summary>{t(label)}</summary><div role="menu" aria-label={t(label)}>{children}</div></details>;
}

function ExplorerRow({ entry, depth, selected, revision }: { entry: Entry; depth: number; selected?: string; revision: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[] | undefined>();
  useEffect(() => {
    let live = true;
    if (expanded) void workbench.entries(entry.path).then(entries => { if (live) setChildren(entries); }).catch(workbench.report);
    return () => { live = false; };
  }, [entry.path, expanded, revision]);
  const open = async () => {
    if (!entry.directory) { if (!entry.symlink) await workbench.openPath(entry.path); return; }
    setExpanded(!expanded);
  };
  return <li role="treeitem" aria-expanded={entry.directory ? expanded : undefined} aria-selected={selected === entry.path}>
    <button type="button" className={`tree-row ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} title={entry.symlink ? t('explorer.symbolicLink') : entry.path} disabled={entry.symlink} onClick={() => run(open)}>
      <span className="tree-chevron" aria-hidden="true">{entry.directory ? expanded ? '⌄' : '›' : ''}</span><span className="file-icon" aria-hidden="true">{entry.directory ? '▱' : entry.name.endsWith('.inc') ? '#' : '⋮'}</span><span>{entry.name}</span>
    </button>
    {expanded && <ul role="group">{children?.map(child => <ExplorerRow key={child.path} entry={child} depth={depth + 1} selected={selected} revision={revision} />)}</ul>}
  </li>;
}

function Explorer({ root, active, revision }: { root?: string; active?: string; revision: number }) {
  const [listing, setListing] = useState<{ root?: string; entries: Entry[] }>({ entries: [] });
  useEffect(() => {
    let live = true;
    if (root) void workbench.entries(root).then(files => { if (live) setListing({ root, entries: files }); }).catch(error => { if (live) setListing({ root, entries: [] }); workbench.report(error); });
    return () => { live = false; };
  }, [root, revision]);
  const selected = active?.startsWith('file:') ? Uri.parse(active).fsPath : undefined;
  const entries = listing.root === root ? listing.entries : undefined;
  if (!root) return <p className="muted explorer-empty">{t('explorer.empty')}</p>;
  return <><div className="workspace-name" title={root}>{root.split(/[\\/]/).at(-1)}</div>{entries ? <ul role="tree" aria-label={t('explorer.title')}>{entries.map(entry => <ExplorerRow key={entry.path} entry={entry} depth={0} selected={selected} revision={revision} />)}</ul> : <p className="muted">{t('explorer.loading')}</p>}</>;
}

function SettingsDialog({ settings, close }: { settings: Settings; close: () => void }) {
  const update = (patch: Partial<Settings>) => run(() => workbench.settings({ ...settings, ...patch }));
  return <Modal label={t('settings.title')} onCancel={close}>
    <h2>{t('settings.title')}</h2>
    <div className="settings-fields">
      <label>{t('settings.theme')}<select aria-label={t('settings.theme')} value={settings.theme} onChange={event => update({ theme: event.target.value === 'light' ? 'light' : 'dark' })}><option value="dark">{t('settings.dark')}</option><option value="light">{t('settings.light')}</option></select></label>
      <label>{t('settings.fontFamily')}<input value={settings.fontFamily} onChange={event => update({ fontFamily: event.target.value })} /></label>
      <label>{t('settings.fontSize')}<input type="number" min="8" max="48" value={settings.fontSize} onChange={event => { const value = Number(event.target.value); if (value >= 8 && value <= 48) update({ fontSize: value }); }} /></label>
      <label>{t('settings.tabSize')}<input type="number" min="1" max="8" value={settings.tabSize} onChange={event => { const value = Number(event.target.value); if (value >= 1 && value <= 8) update({ tabSize: value }); }} /></label>
      {(['insertSpaces', 'wordWrap', 'minimap', 'formatOnSave'] as const).map(key => <label className="checkbox" key={key}><input type="checkbox" checked={settings[key]} onChange={event => update({ [key]: event.target.checked })} />{t(`settings.${key}`)}</label>)}
    </div><footer><button type="button" onClick={close}>{t('command.dismiss')}</button></footer>
  </Modal>;
}

function App() {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot);
  const container = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [treeRevision, setTreeRevision] = useState(0);
  const active = Boolean(state.active);
  const external = state.tabs.find(tab => tab.uri === state.active)?.external;
  const connected = state.status === t('status.connected');
  const nativeReady = desktop && state.ready;
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    if (container.current) void workbench.mount(container.current).then(dispose => { if (disposed) dispose(); else cleanup = dispose; }).catch(workbench.report);
    return () => { disposed = true; cleanup?.(); };
  }, []);
  useEffect(() => {
    let chordUntil = 0;
    const handle = (event: KeyboardEvent) => {
      if (state.prompt || settingsOpen) return;
      const modifier = event.ctrlKey || event.metaKey;
      let operation: (() => Promise<unknown>) | undefined;
      const key = event.key.toLowerCase();
      if (modifier && key === 'k') { chordUntil = Date.now() + 1500; event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (Date.now() < chordUntil && key === 'o') operation = () => workbench.chooseFolder();
      else if (modifier && key === 'o') operation = () => workbench.openFile();
      else if (modifier && key === 'n') operation = () => workbench.newFile();
      else if (modifier && key === 's') operation = event.altKey ? () => workbench.saveAll() : () => workbench.save(undefined, event.shiftKey);
      else if (modifier && key === 'w' && state.active) operation = () => workbench.close(state.active!);
      else if (modifier && event.shiftKey && key === 't') operation = () => workbench.reopen();
      else if (modifier && key === ',') { event.preventDefault(); event.stopImmediatePropagation(); setSettingsOpen(true); return; }
      else if (modifier && key === 'j') { event.preventDefault(); event.stopImmediatePropagation(); setProblemsOpen(value => !value); return; }
      if (operation && nativeReady) { event.preventDefault(); event.stopImmediatePropagation(); run(operation); }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [state.active, state.prompt, nativeReady, settingsOpen]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (state.tabs.some(tab => tab.dirty)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [state.tabs]);

  return <main className="workbench" style={themeVariables(defaultThemes[state.settings.theme]) as CSSProperties}>
    <header className="ide-menubar"><span className="app-mark" aria-label={t('app.name')}>♟</span>
      <nav aria-label={t('app.name')}>
        <Menu label="menu.file">
          <MenuItem label="command.newFile" shortcut="Ctrl+N" disabled={!nativeReady} action={() => run(() => workbench.newFile())} />
          <MenuItem label="command.openFile" shortcut="Ctrl+O" disabled={!nativeReady} action={() => run(() => workbench.openFile())} />
          <MenuItem label="command.openFolder" shortcut="Ctrl+K Ctrl+O" disabled={!nativeReady} action={() => run(() => workbench.chooseFolder())} />
          <hr />
          <MenuItem label="command.save" shortcut="Ctrl+S" disabled={!active} action={() => run(() => workbench.save())} />
          <MenuItem label="command.saveAs" shortcut="Ctrl+Shift+S" disabled={!active} action={() => run(() => workbench.save(undefined, true))} />
          <MenuItem label="command.saveAll" shortcut="Ctrl+Alt+S" disabled={!active} action={() => run(() => workbench.saveAll())} />
          <hr />
          <MenuItem label="command.close" shortcut="Ctrl+W" disabled={!active} action={() => run(() => workbench.close(state.active!))} />
          <MenuItem label="command.reopen" shortcut="Ctrl+Shift+T" disabled={!nativeReady} action={() => run(() => workbench.reopen())} />
          <MenuItem label="command.reload" disabled={!active} action={() => run(() => workbench.reload())} />
          <hr /><MenuItem label="command.quit" disabled={!nativeReady} action={() => run(() => workbench.quit())} />
        </Menu>
        <Menu label="menu.edit">
          {([['command.undo', 'undo', 'Ctrl+Z'], ['command.redo', 'redo', 'Ctrl+Y'], ['command.find', 'actions.find', 'Ctrl+F'], ['command.replace', 'editor.action.startFindReplaceAction', 'Ctrl+H']] as const).map(([label, action, shortcut]) => <MenuItem key={action} label={label} shortcut={shortcut} disabled={!active} action={() => run(() => workbench.action(action))} />)}
          <MenuItem label="command.format" shortcut="Shift+Alt+F" disabled={!active || !connected} action={() => run(() => workbench.action('editor.action.formatDocument'))} />
        </Menu>
        <Menu label="menu.view"><MenuItem label="command.problems" shortcut="Ctrl+J" action={() => setProblemsOpen(value => !value)} /><MenuItem label="command.settings" shortcut="Ctrl+," disabled={!state.ready} action={() => setSettingsOpen(true)} /></Menu>
        <Menu label="menu.go">
          {([['command.definition', 'editor.action.revealDefinition', 'F12'], ['command.references', 'editor.action.goToReferences', 'Shift+F12'], ['command.rename', 'editor.action.rename', 'F2'], ['command.symbols', 'editor.action.quickOutline', 'Ctrl+Shift+O']] as const).map(([label, action, shortcut]) => <MenuItem key={action} label={label} shortcut={shortcut} disabled={!active || !connected} action={() => run(() => workbench.action(action))} />)}
          <MenuItem label="command.restartLanguage" disabled={!nativeReady} action={() => run(() => workbench.restartLanguage())} />
        </Menu>
      </nav><span className="window-title">{state.root?.split(/[\\/]/).at(-1) ?? t('app.name')}</span>
    </header>
    {state.error && <div className="error-banner" role="alert"><span>{state.error}</span><button type="button" onClick={workbench.dismissError} aria-label={t('command.dismiss')}>×</button></div>}
    <div className="workspace-body">
      <aside className="explorer"><div className="panel-heading"><span>{t('explorer.title')}</span><button type="button" disabled={!state.root} onClick={() => setTreeRevision(value => value + 1)} title={t('command.refresh')} aria-label={t('command.refresh')}>↻</button></div><Explorer root={state.root} active={state.active} revision={treeRevision + state.treeVersion} /></aside>
      <section className="editor-column">
        <div className="tabs" role="tablist" aria-label={t('editor.tabs')}>{state.tabs.map(tab => <div className={`tab ${tab.uri === state.active ? 'active' : ''}`} key={tab.uri}>
          <button type="button" role="tab" aria-selected={tab.uri === state.active} onClick={() => workbench.activate(tab.uri)}><span className="file-icon" aria-hidden="true">#</span>{tab.name}</button>
          <button type="button" className={tab.dirty ? 'dirty close-tab' : 'close-tab'} onClick={() => run(() => workbench.close(tab.uri))} aria-label={t('editor.closeTab', { name: tab.name })} title={tab.dirty ? t('editor.dirty') : t('command.close')}>{tab.dirty ? '●' : '×'}</button>
        </div>)}</div>
        {external && <div className="external-notice" role="status"><span>{t(external === 'changed' ? 'editor.externalChanged' : 'editor.externalDeleted')}</span>{external === 'changed' && <button type="button" onClick={() => run(() => workbench.reload())}>{t('command.reload')}</button>}<button type="button" onClick={() => run(() => workbench.save(undefined, true))}>{t('command.saveAs')}</button></div>}
        <div className="editor-area"><div className="monaco-container" ref={container} />
          {!active && <div className="empty-editor"><h1>{t('app.name')}</h1><p>{t('editor.welcome')}</p><p className="muted">{state.ready ? desktop ? t('editor.empty') : t('editor.desktopRequired') : t('editor.loading')}</p>
            <div className="welcome-actions"><button type="button" disabled={!nativeReady} onClick={() => run(() => workbench.openFile())}>{t('command.openFile')}<kbd>Ctrl+O</kbd></button><button type="button" disabled={!nativeReady} onClick={() => run(() => workbench.chooseFolder())}>{t('command.openFolder')}<kbd>Ctrl+K Ctrl+O</kbd></button></div>
            {state.recent.length > 0 && <><h2>{t('recent.title')}</h2><ul className="recent-list">{state.recent.map(path => <li key={path}><button type="button" title={path} onClick={() => run(() => workbench.chooseFolder(path))}>{path}</button></li>)}</ul></>}
          </div>}
        </div>
        {problemsOpen && <section className="problems-panel"><div className="panel-heading"><span>{t('command.problems')} ({state.problems.length})</span><button type="button" onClick={() => setProblemsOpen(false)} aria-label={t('command.close')}>×</button></div>
          {state.problems.length ? <ul>{state.problems.map((problem, index) => <li key={index}><button type="button" onClick={() => run(() => workbench.openUri(problem.resource.toString(), problem.startLineNumber, problem.startColumn))}><span className={problem.severity === 8 ? 'problem-error' : 'problem-warning'} aria-hidden="true">●</span><span>{problem.message}</span><small>{t('problems.location', { file: problem.resource.path.split('/').at(-1) ?? '', line: problem.startLineNumber, column: problem.startColumn })}</small></button></li>)}</ul> : <p className="muted">{t('problems.empty')}</p>}
        </section>}
      </section>
    </div>
    <footer className="statusbar"><span>{state.status}</span><button type="button" onClick={() => setProblemsOpen(value => !value)}>{t('status.problems', { count: state.problems.length })}</button><span className="status-spacer" />{active && <><span>{t('status.position', state.position)}</span><span>UTF-8</span></>}</footer>
    {state.prompt && <Modal label={t('prompt.unsaved', { name: state.prompt.name })} onCancel={() => workbench.answerPrompt('cancel')}><h2>{t('prompt.unsaved', { name: state.prompt.name })}</h2><p>{t('prompt.unsavedDetail')}</p><footer><button type="button" className="primary" onClick={() => workbench.answerPrompt('save')}>{t('prompt.save')}</button><button type="button" onClick={() => workbench.answerPrompt('discard')}>{t('prompt.discard')}</button><button type="button" onClick={() => workbench.answerPrompt('cancel')}>{t('prompt.cancel')}</button></footer></Modal>}
    {settingsOpen && <SettingsDialog settings={state.settings} close={() => setSettingsOpen(false)} />}
  </main>;
}

export default App;
