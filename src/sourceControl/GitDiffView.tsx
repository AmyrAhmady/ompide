import { workbench } from "../app/workbench";
import { childPath } from "../lib/paths";
import { useEffect, useRef } from "react";
import { editor } from "monaco-editor";
import { t } from "../lib/i18n";
import type { OpenGitDiff } from "./types";

export function GitDiffView({
  diff,
  close,
}: {
  diff: OpenGitDiff;
  close: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || diff.unsupported) return;
    const language = /\.(pwn|inc)$/i.test(diff.path) ? "pawn" : "plaintext";
    const original = editor.createModel(diff.before, language);
    const modified = editor.createModel(diff.after, language);
    const view = editor.createDiffEditor(container.current, {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      renderSideBySide: true,
      diffAlgorithm: "legacy",
      originalAriaLabel: t(diff.staged ? "scm.head" : "scm.index"),
      modifiedAriaLabel: t(
        diff.staged ? "scm.index" : diff.unsaved ? "scm.buffer" : "scm.disk"
      ),
    });
    view.setModel({ original, modified });
    return () => {
      view.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [diff]);
  return (
    <section className="git-diff-view" aria-label={t("scm.diff")}>
      <header className="panel-heading">
        <span>
          {diff.path} — {t(diff.staged ? "scm.stagedDiff" : "scm.workingDiff")}
        </span>
        <button
          type="button"
          onClick={() => {
            const root = workbench.getSnapshot().root;
            if (root)
              void workbench
                .openPath(childPath(root, diff.path))
                .then(close)
                .catch(workbench.report);
          }}
        >
          {t("scm.openFile")}
        </button>
        <button type="button" onClick={close}>
          {t("command.close")}
        </button>
      </header>
      <p className="muted git-diff-labels">
        {t(
          diff.staged
            ? "scm.compareStaged"
            : diff.unsaved
              ? "scm.compareBuffer"
              : "scm.compareWorking"
        )}
      </p>
      {diff.unsupported ? (
        <p>{t("scm.unsupported")}</p>
      ) : (
        <div ref={container} className="git-diff-editor" />
      )}
    </section>
  );
}
