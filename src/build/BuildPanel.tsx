import { useEffect, useRef } from 'react';
import { t } from '../lib/i18n';
import { workbench } from '../app/workbench';
import { building, type BuildState } from './types';

export function BuildPanel({ state, close, configure }: { state: BuildState; close: () => void; configure: () => void }) {
  const output = useRef<HTMLPreElement>(null);
  const report = state.result?.report;
  const log = [report?.process.stdout, report?.process.stderr, state.result?.stdout, state.result?.stderr].filter(Boolean).join('\n');
  useEffect(() => { output.current?.scrollTo(0, output.current.scrollHeight); }, [log]);
  const busy = building(state);
  return <section className="build-panel" aria-label={t('build.output')}>
    <div className="panel-heading"><span>{t('build.output')} — {t(`build.${state.phase}`)}</span><div><button type="button" disabled={busy} onClick={configure} title={t('project.title')} aria-label={t('project.title')}>⚙</button>{busy && <button type="button" onClick={() => { void workbench.cancelBuild().catch(workbench.report); }}>{t('build.cancel')}</button>}<button type="button" onClick={close} aria-label={t('command.close')}>×</button></div></div>
    <div className="build-summary" role="status"><span className={state.phase === 'failed' ? 'problem-error' : undefined}>{state.error || t(`build.${state.phase}`)}</span>{state.entry && <span>{state.entry}</span>}{state.elapsed !== undefined && <span>{t('build.elapsed', { seconds: Math.round(state.elapsed / 100) / 10 })}</span>}{report?.process.exitCode != null && <span>{t('build.exitCode', { code: report.process.exitCode })}</span>}{busy && <p>{t('build.buffered')}</p>}{state.result && state.result.outcome !== 'completed' && <p>{t(`build.${state.result.outcome}`)}</p>}{report?.process.truncated && <p>{t('build.truncated')}</p>}{report?.artifacts.map(artifact => <p key={artifact.path} className="build-artifact">{t('build.artifact', { path: artifact.path, bytes: artifact.size })}</p>)}</div>
    {report && report.diagnostics.length > 0 && <ul className="build-diagnostics">{report.diagnostics.map((diagnostic, index) => <li key={index}><button type="button" onClick={() => { const position = diagnostic.primary.range?.start; void workbench.openUri(diagnostic.primary.uri, (position?.line ?? 0) + 1, (position?.character ?? 0) + 1).catch(workbench.report); }}><span className={diagnostic.severity === 'error' ? 'problem-error' : 'problem-warning'}>{diagnostic.code}</span><span>{diagnostic.message}</span><small>{diagnostic.primary.uri.split('/').at(-1)}:{(diagnostic.primary.range?.start.line ?? 0) + 1}</small></button></li>)}</ul>}
    <pre className="build-log" ref={output} tabIndex={0} aria-label={t('build.log')}>{log || t('build.noOutput')}</pre>
  </section>;
}
