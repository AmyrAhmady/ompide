import { useEffect, useRef, useState } from "react";
import { editor } from "monaco-editor";
import { workbench } from "../app/workbench";
import { Modal } from "../components/Modal";
import { describeError, t } from "../lib/i18n";
import type { SearchFile, SearchOptions, SearchResult } from "./types";

const empty: SearchResult = {
  files: [],
  scanned: 0,
  skipped: 0,
  truncated: false,
  cancelled: false,
};

export interface SearchFields {
  query: string;
  fileQuery: string;
  replacement: string;
  matchCase: boolean;
}

export const initialSearchFields: SearchFields = {
  query: "",
  fileQuery: "",
  replacement: "",
  matchCase: false,
};

function Diff({ file }: { file: SearchFile }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const original = editor.createModel(file.before ?? "", "plaintext");
    const modified = editor.createModel(file.after ?? "", "plaintext");
    const diff = editor.createDiffEditor(container.current, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: false,
      minimap: { enabled: false },
      diffAlgorithm: "legacy",
      originalAriaLabel: t("search.before"),
      modifiedAriaLabel: t("search.after"),
    });
    diff.setModel({ original, modified });
    return () => {
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [file]);
  return <div className="replacement-diff" ref={container} />;
}

function ReplacePreview({
  result,
  root,
  close,
  applied,
}: {
  result: SearchResult;
  root: string;
  close: () => void;
  applied: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const count = result.files.reduce(
    (count, file) => count + file.hits.length,
    0
  );
  const complete = !result.truncated && !result.cancelled;
  return (
    <Modal
      label={t("search.replaceTitle")}
      onCancel={() => {
        if (!busy) close();
      }}
    >
      <div className="replacement-preview">
        <h2>{t("search.replaceTitle")}</h2>
        <p>
          {t("search.replaceConfirm", { count, files: result.files.length })}
        </p>
        <p className="muted">{t("search.bufferHint")}</p>
        {!complete && (
          <p role="alert" className="problem-warning">
            {t("search.previewIncomplete")}
          </p>
        )}
        {result.skipped > 0 && (
          <p className="muted">
            {t("search.skipped", { count: result.skipped })}
          </p>
        )}
        {error && (
          <p role="alert" className="problem-error">
            {error}
          </p>
        )}
        {result.files.length > 0 && (
          <>
            <select
              aria-label={t("search.previewFile")}
              value={index}
              disabled={busy}
              onChange={(event) => setIndex(Number(event.target.value))}
            >
              {result.files.map((file, index) => (
                <option key={file.uri} value={index}>
                  {file.relative} ({file.hits.length})
                </option>
              ))}
            </select>
            <Diff file={result.files[index]} />
          </>
        )}
        <footer>
          <button
            type="button"
            className="primary"
            disabled={busy || !complete || !result.files.length}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void workbench
                .applyReplacements(result, root)
                .then(applied)
                .catch((error) => setError(describeError(error)))
                .finally(() => setBusy(false));
            }}
          >
            {t("search.apply")}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            {t("prompt.cancel")}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

export function SearchPanel({
  root,
  fields,
  change,
  close,
}: {
  root?: string;
  fields: SearchFields;
  change: (fields: SearchFields) => void;
  close: () => void;
}) {
  const [result, setResult] = useState<SearchResult>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{
    root: string;
    result: SearchResult;
  }>();
  const [refresh, setRefresh] = useState(0);
  const { query, fileQuery, matchCase, replacement } = fields;
  const options: SearchOptions = {
    query,
    fileQuery,
    matchCase,
    filesOnly: false,
  };
  useEffect(() => {
    let live = true;
    setResult(empty);
    setError(undefined);
    setBusy(Boolean(root && query));
    const timer = setTimeout(() => {
      if (root && query)
        void workbench
          .search({ query, fileQuery, matchCase, filesOnly: false })
          .then((result) => {
            if (live) {
              setResult(result);
              setBusy(false);
            }
          })
          .catch((error) => {
            if (live) {
              setError(describeError(error));
              setBusy(false);
            }
          });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
      void workbench.cancelSearch().catch(workbench.report);
    };
  }, [query, fileQuery, matchCase, root, refresh]);
  const count = result.files.reduce(
    (count, file) => count + file.hits.length,
    0
  );
  return (
    <div className="workspace-search">
      <div className="panel-heading">
        <span>{t("search.title")}</span>
        <div>
          <button
            type="button"
            disabled={!root || !query || busy}
            onClick={() => setRefresh((value) => value + 1)}
            aria-label={t("search.refresh")}
            title={t("search.refresh")}
          >
            ↻
          </button>
          <button type="button" onClick={close} aria-label={t("search.close")}>
            ×
          </button>
        </div>
      </div>
      <div className="search-fields">
        <label className="search-query-row">
          <input
            autoFocus
            type="text"
            maxLength={1024}
            value={query}
            placeholder={t("search.query")}
            aria-label={t("search.query")}
            disabled={!root}
            onChange={(event) =>
              change({ ...fields, query: event.target.value })
            }
          />
          <button
            type="button"
            aria-label={t("search.matchCase")}
            title={t("search.matchCase")}
            aria-pressed={matchCase}
            onClick={() => change({ ...fields, matchCase: !matchCase })}
          >
            Aa
          </button>
        </label>
        <input
          type="text"
          maxLength={1024}
          value={fileQuery}
          aria-label={t("search.fileFilter")}
          placeholder={t("search.fileFilter")}
          disabled={!root}
          onChange={(event) =>
            change({ ...fields, fileQuery: event.target.value })
          }
        />
        <input
          type="text"
          maxLength={65536}
          value={replacement}
          aria-label={t("search.replacement")}
          placeholder={t("search.replacement")}
          disabled={!root}
          onChange={(event) =>
            change({ ...fields, replacement: event.target.value })
          }
        />
        <div className="search-buttons">
          <button
            type="button"
            disabled={!root || !query || busy}
            onClick={() => {
              if (!root) return;
              setBusy(true);
              setError(undefined);
              void workbench
                .search(options, replacement)
                .then((result) => setPreview({ root, result }))
                .catch((error) => setError(describeError(error)))
                .finally(() => setBusy(false));
            }}
          >
            {t("search.previewReplace")}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                void workbench.cancelSearch().catch(workbench.report);
              }}
            >
              {t("search.cancel")}
            </button>
          )}
        </div>
      </div>
      <div className="search-status" role="status">
        {!root
          ? t("explorer.empty")
          : busy
            ? t("search.searching")
            : result.cancelled
              ? t("search.cancelled")
              : query
                ? t("search.results", { count, files: result.files.length })
                : t("search.hint")}
      </div>
      {error && (
        <p className="search-status problem-error" role="alert">
          {error}
        </p>
      )}
      {result.truncated && (
        <p className="search-status problem-warning">{t("search.truncated")}</p>
      )}
      {result.skipped > 0 && (
        <p className="search-status muted">
          {t("search.skipped", { count: result.skipped })}
        </p>
      )}
      <ul className="search-results">
        {result.files.map((file) => (
          <li key={file.uri}>
            <div className="search-file" title={file.path}>
              {file.relative}
              {file.bufferVersion !== null && (
                <small>{t("search.unsaved")}</small>
              )}
            </div>
            <ul>
              {file.hits.map((hit, index) => (
                <li key={index}>
                  <button
                    type="button"
                    title={`${file.relative}:${hit.line}:${hit.column}`}
                    onClick={() => {
                      void workbench
                        .openUri(file.uri, hit.line, hit.column)
                        .catch(workbench.report);
                    }}
                  >
                    <span className="search-line">{hit.line}</span>
                    <span>{hit.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {preview && (
        <ReplacePreview
          root={preview.root}
          result={preview.result}
          close={() => setPreview(undefined)}
          applied={() => {
            setPreview(undefined);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

export function QuickOpen({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>(empty);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(undefined);
    const timer = setTimeout(() => {
      void workbench
        .search({ query, fileQuery: "", filesOnly: true, matchCase: false })
        .then((result) => {
          if (live) {
            setResult(result);
            setSelected(0);
            setBusy(false);
          }
        })
        .catch((error) => {
          if (live) {
            setError(describeError(error));
            setBusy(false);
          }
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
      void workbench.cancelSearch().catch(workbench.report);
    };
  }, [query]);

  const open = (file: SearchFile) => {
    close();
    void workbench.openUri(file.uri).catch(workbench.report);
  };
  return (
    <Modal label={t("search.files")} onCancel={close}>
      <h2>{t("search.files")}</h2>
      <input
        autoFocus
        className="symbol-query"
        aria-label={t("search.fileQuery")}
        role="combobox"
        aria-expanded="true"
        aria-controls="quick-open-results"
        aria-activedescendant={
          result.files[selected] ? `quick-open-${selected}` : undefined
        }
        value={query}
        maxLength={1024}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) =>
              result.files.length
                ? (index +
                    (event.key === "ArrowDown" ? 1 : result.files.length - 1)) %
                  result.files.length
                : 0
            );
          }
          if (event.key === "Enter" && result.files[selected]) {
            event.preventDefault();
            open(result.files[selected]);
          }
        }}
      />
      {error && (
        <p role="alert" className="problem-error">
          {error}
        </p>
      )}
      <div
        className="symbol-results quick-open-results"
        role="listbox"
        id="quick-open-results"
        aria-label={t("search.files")}
        aria-busy={busy}
      >
        {result.files.map((file, index) => (
          <button
            type="button"
            role="option"
            id={`quick-open-${index}`}
            aria-selected={selected === index}
            key={file.uri}
            title={file.path}
            onClick={() => open(file)}
          >
            {file.relative}
          </button>
        ))}
      </div>
      <p className="muted" role="status">
        {t(
          busy
            ? "search.searching"
            : result.truncated
              ? "search.fileLimit"
              : result.files.length
                ? "search.filesHint"
                : "search.noFiles"
        )}
      </p>
      <footer>
        <button type="button" onClick={close}>
          {t("prompt.cancel")}
        </button>
      </footer>
    </Modal>
  );
}
