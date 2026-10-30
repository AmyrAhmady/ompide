import { memo, useCallback, useEffect, useRef, useState } from "react";
import { native, desktop } from "../lib/native";
import { t, type TranslationKey } from "../lib/i18n";
import { describeGitError } from "./errors";
import { workbench } from "../app/workbench";
import { Modal } from "../components/Modal";
import {
  changesFiles,
  type GitAction,
  type GitChange,
  type GitDiff,
  type GitSnapshot,
  type OpenGitDiff,
} from "./types";

const labels: Record<GitAction["kind"], TranslationKey> = {
  stage: "scm.stage",
  unstage: "scm.unstage",
  commit: "scm.commit",
  undo: "scm.undo",
  switch: "scm.switch",
  createBranch: "scm.createBranch",
  renameBranch: "scm.renameBranch",
  deleteBranch: "scm.deleteBranch",
  createTag: "scm.createTag",
  deleteTag: "scm.deleteTag",
  push: "scm.push",
  pull: "scm.pull",
  pushTag: "scm.pushTag",
  stash: "scm.stash",
  applyStash: "scm.applyStash",
  popStash: "scm.popStash",
  dropStash: "scm.dropStash",
};

let sequence = Date.now();

function rawError(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
    ? error.detail
    : "";
}

export const SourceControlPanel = memo(function SourceControlPanel({
  root,
  ready,
  visible,
  openDiff,
}: {
  root?: string;
  ready: boolean;
  visible: boolean;
  openDiff: (diff: OpenGitDiff) => void;
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [tagName, setTagName] = useState("");
  const [stash, setStash] = useState("");
  const [remote, setRemote] = useState("");
  const [pending, setPending] = useState<{
    action: GitAction;
    revision: string;
  }>();
  const [stashMessage, setStashMessage] = useState("");
  const task = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const confirming = useRef(false);

  const refresh = useCallback(async () => {
    if (!root || !ready || !desktop || task.current || confirming.current)
      return;
    const id = ++sequence;
    const current = generation.current;
    task.current = id;
    setBusy(true);
    try {
      const next = await native.git<GitSnapshot>(root, id, { kind: "status" });
      if (current !== generation.current) return;
      setSnapshot(next);
      setBranch((value) =>
        next.branches.includes(value) ? value : next.branch
      );
      setTag((value) =>
        next.tags.includes(value) ? value : (next.tags[0] ?? "")
      );
      setStash((value) =>
        next.stashes.some((item) => item.startsWith(`${value}: `))
          ? value
          : (next.stashes[0]?.split(": ")[0] ?? "")
      );
      setRemote((value) =>
        next.remotes.includes(value) ? value : (next.remotes[0] ?? "")
      );
    } catch (failure) {
      if (current !== generation.current) return;
      setSnapshot(undefined);
      setError(describeGitError(failure));
      setOutput(rawError(failure));
    } finally {
      if (task.current === id) {
        task.current = undefined;
        setBusy(false);
      }
    }
  }, [root, ready]);

  useEffect(() => {
    ++generation.current;
    setSnapshot(undefined);
    setError(undefined);
    setOutput("");
    setPending(undefined);
    confirming.current = false;
    setMessage("");
    return () => {
      ++generation.current;
      if (task.current)
        void native.cancelGit(task.current).catch(() => undefined);
    };
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.hasFocus()) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  const execute = async (action: GitAction, revision = snapshot?.revision) => {
    if (!root || !snapshot || !revision || task.current) return;
    const id = ++sequence;
    task.current = id;
    setBusy(true);
    confirming.current = false;
    setPending(undefined);
    setError(undefined);
    setOutput("");
    try {
      const result = await workbench.runGit(root, id, revision, action);
      setOutput(result || t("scm.completed"));
      if (action.kind === "commit") setMessage("");
      if (action.kind === "createBranch" || action.kind === "switch")
        setBranch(action.name);
      if (action.kind === "renameBranch") setBranch(action.newName);
    } catch (failure) {
      setError(describeGitError(failure));
      setOutput(rawError(failure));
    } finally {
      task.current = undefined;
      setBusy(false);
      // Refresh after failure too: a cancelled operation or failed stash pop can change files.
      await refresh();
    }
  };

  const request = (action: GitAction) => {
    if (
      [
        "stage",
        "unstage",
        "createBranch",
        "createTag",
        "renameBranch",
        "applyStash",
      ].includes(action.kind) ||
      (action.kind === "commit" && !action.amend)
    )
      void execute(action);
    else if (snapshot) {
      confirming.current = true;
      setPending({ action, revision: snapshot.revision });
    }
  };

  const showDiff = async (change: GitChange, staged: boolean) => {
    if (!root || task.current) return;
    const id = ++sequence;
    task.current = id;
    setBusy(true);
    try {
      const value = await native.git<GitDiff>(root, id, {
        kind: "diff",
        path: change.path,
        staged,
      });
      openDiff(workbench.gitDiff(change.path, staged, value));
    } catch (failure) {
      setError(describeGitError(failure));
      setOutput(rawError(failure));
    } finally {
      task.current = undefined;
      setBusy(false);
    }
  };

  const group = (staged: boolean) => {
    const changes =
      snapshot?.changes.filter((change) =>
        staged
          ? change.index !== "." && change.index !== "?"
          : change.working !== "."
      ) ?? [];
    return (
      <section
        className="scm-changes"
        aria-label={t(staged ? "scm.staged" : "scm.changes")}
      >
        <div className="panel-heading">
          <strong>
            {t(staged ? "scm.staged" : "scm.changes")} ({changes.length})
          </strong>
          <button
            type="button"
            disabled={busy || !changes.length}
            onClick={() =>
              request({
                kind: staged ? "unstage" : "stage",
                paths: changesFiles(changes),
              })
            }
          >
            {t(staged ? "scm.unstageAll" : "scm.stageAll")}
          </button>
        </div>
        <ul>
          {changes.map((change) => (
            <li key={change.path}>
              <button
                type="button"
                className="scm-file"
                disabled={busy}
                title={
                  change.original
                    ? `${change.original} → ${change.path}`
                    : change.path
                }
                onClick={() => void showDiff(change, staged)}
              >
                <span>{change.path}</span>
                <b>
                  {change.conflict
                    ? "!"
                    : staged
                      ? change.index
                      : change.working}
                </b>
              </button>
              <button
                type="button"
                disabled={busy || change.submodule}
                aria-label={t(staged ? "scm.unstageFile" : "scm.stageFile", {
                  path: change.path,
                })}
                title={t(staged ? "scm.unstage" : "scm.stage")}
                onClick={() =>
                  request({
                    kind: staged ? "unstage" : "stage",
                    paths: changesFiles([change]),
                  })
                }
              >
                {staged ? "−" : "+"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  return (
    <section
      className="source-control"
      hidden={!visible}
      aria-label={t("scm.title")}
    >
      <header className="panel-heading">
        <strong>{t("scm.title")}</strong>
        <button
          type="button"
          disabled={busy || !ready || !root}
          onClick={() => {
            setError(undefined);
            void refresh();
          }}
        >
          {t("scm.refresh")}
        </button>
      </header>
      {!root ? (
        <p>{t("scm.noWorkspace")}</p>
      ) : !desktop ? (
        <p>{t("editor.desktopRequired")}</p>
      ) : (
        <>
          {busy && (
            <div className="scm-progress" role="status">
              {t("scm.busy")}{" "}
              <button
                type="button"
                onClick={() => {
                  if (task.current)
                    void native.cancelGit(task.current).catch(workbench.report);
                }}
              >
                {t("prompt.cancel")}
              </button>
            </div>
          )}
          {error && (
            <p className="scm-error" role="alert">
              {error}
            </p>
          )}
          {snapshot && (
            <>
              <p className="scm-branch">
                {snapshot.branch}{" "}
                {snapshot.head !== "(initial)" && (
                  <small>{snapshot.head.slice(0, 8)}</small>
                )}
              </p>
              {snapshot.upstream && (
                <p className="muted scm-upstream">
                  {snapshot.upstream} ↑{snapshot.ahead} ↓{snapshot.behind}
                </p>
              )}
              <p className="muted">{t("scm.diskNotice")}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void workbench
                    .saveAll()
                    .then(() => refresh())
                    .catch(workbench.report)
                }
              >
                {t("command.saveAll")}
              </button>
              <label>
                {t("scm.message")}
                <textarea
                  rows={3}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <div className="scm-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    busy ||
                    !message.trim() ||
                    !snapshot.changes.some(
                      (change) => change.index !== "." && change.index !== "?"
                    )
                  }
                  onClick={() =>
                    request({ kind: "commit", message, amend: false })
                  }
                >
                  {t("scm.commit")}
                </button>
                <button
                  type="button"
                  disabled={
                    busy || !message.trim() || snapshot.head === "(initial)"
                  }
                  onClick={() =>
                    request({ kind: "commit", message, amend: true })
                  }
                >
                  {t("scm.amend")}
                </button>
                <button
                  type="button"
                  disabled={busy || snapshot.head === "(initial)"}
                  onClick={() => request({ kind: "undo" })}
                >
                  {t("scm.undo")}
                </button>
              </div>
              {group(true)}
              {group(false)}
              <details>
                <summary>{t("scm.remotes")}</summary>
                <fieldset disabled={busy || !snapshot.remotes.length}>
                  <label>
                    {t("scm.remote")}
                    <select
                      value={remote}
                      onChange={(event) => setRemote(event.target.value)}
                    >
                      {snapshot.remotes.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <div className="scm-actions">
                    <button
                      type="button"
                      onClick={() => request({ kind: "push", remote })}
                    >
                      {t("scm.push")}
                    </button>
                    <button
                      type="button"
                      onClick={() => request({ kind: "pull", remote })}
                    >
                      {t("scm.pull")}
                    </button>
                  </div>
                </fieldset>
                {!snapshot.remotes.length && <p>{t("scm.noRemote")}</p>}
              </details>
              <details>
                <summary>{t("scm.branches")}</summary>
                <fieldset disabled={busy}>
                  <label>
                    {t("scm.branch")}
                    <select
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                    >
                      {snapshot.branches.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <div className="scm-actions">
                    <button
                      type="button"
                      disabled={!branch || branch === snapshot.branch}
                      onClick={() => request({ kind: "switch", name: branch })}
                    >
                      {t("scm.switch")}
                    </button>
                    <button
                      type="button"
                      disabled={!branch || branch === snapshot.branch}
                      onClick={() =>
                        request({ kind: "deleteBranch", name: branch })
                      }
                    >
                      {t("scm.deleteBranch")}
                    </button>
                  </div>
                  <label>
                    {t("scm.newName")}
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <div className="scm-actions">
                    <button
                      type="button"
                      disabled={!name.trim()}
                      onClick={() => request({ kind: "createBranch", name })}
                    >
                      {t("scm.createBranch")}
                    </button>
                    <button
                      type="button"
                      disabled={!name.trim() || !branch}
                      onClick={() =>
                        request({
                          kind: "renameBranch",
                          name: branch,
                          newName: name,
                        })
                      }
                    >
                      {t("scm.renameBranch")}
                    </button>
                  </div>
                </fieldset>
              </details>
              <details>
                <summary>{t("scm.tags")}</summary>
                <fieldset disabled={busy}>
                  <label>
                    {t("scm.tag")}
                    <select
                      value={tag}
                      onChange={(event) => setTag(event.target.value)}
                    >
                      {snapshot.tags.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <div className="scm-actions">
                    <button
                      type="button"
                      disabled={!tag}
                      onClick={() => request({ kind: "deleteTag", name: tag })}
                    >
                      {t("scm.deleteTag")}
                    </button>
                    <button
                      type="button"
                      disabled={!tag || !remote}
                      onClick={() =>
                        request({ kind: "pushTag", name: tag, remote })
                      }
                    >
                      {t("scm.pushTag")}
                    </button>
                  </div>
                  <label>
                    {t("scm.newTag")}
                    <input
                      value={tagName}
                      onChange={(event) => setTagName(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!tagName.trim()}
                    onClick={() =>
                      request({ kind: "createTag", name: tagName })
                    }
                  >
                    {t("scm.createTag")}
                  </button>
                </fieldset>
              </details>
              <details>
                <summary>{t("scm.stashes")}</summary>
                <fieldset disabled={busy}>
                  <label>
                    {t("scm.stashMessage")}
                    <input
                      value={stashMessage}
                      onChange={(event) => setStashMessage(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      request({ kind: "stash", message: stashMessage })
                    }
                  >
                    {t("scm.stash")}
                  </button>
                  <label>
                    {t("scm.stashed")}
                    <select
                      value={stash}
                      onChange={(event) => setStash(event.target.value)}
                    >
                      {snapshot.stashes.map((item) => (
                        <option key={item} value={item.split(": ")[0]}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="scm-actions">
                    {(["applyStash", "popStash", "dropStash"] as const).map(
                      (kind) => (
                        <button
                          key={kind}
                          type="button"
                          disabled={!stash}
                          onClick={() => request({ kind, name: stash })}
                        >
                          {t(labels[kind])}
                        </button>
                      )
                    )}
                  </div>
                </fieldset>
              </details>
              <details>
                <summary>{t("scm.behavior")}</summary>
                <p className="muted">{t("scm.hooksNotice")}</p>
              </details>
            </>
          )}
          {output && (
            <details open>
              <summary>{t("scm.output")}</summary>
              <pre className="scm-output">{output}</pre>
            </details>
          )}
        </>
      )}
      {pending && (
        <Modal
          label={t("scm.confirmTitle")}
          onCancel={() => {
            confirming.current = false;
            setPending(undefined);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void execute(pending.action, pending.revision);
            }}
          >
            <h2>
              {t(
                pending.action.kind === "commit" && pending.action.amend
                  ? "scm.amend"
                  : labels[pending.action.kind]
              )}
            </h2>
            <p>
              {t(
                pending.action.kind === "undo"
                  ? "scm.undoNotice"
                  : pending.action.kind === "commit"
                    ? "scm.amendNotice"
                    : pending.action.kind === "stash"
                      ? "scm.stashNotice"
                      : "scm.confirmNotice"
              )}
            </p>
            <pre>
              {"name" in pending.action
                ? pending.action.name
                : "remote" in pending.action
                  ? pending.action.remote
                  : snapshot?.branch}
            </pre>
            <footer>
              <button
                type="button"
                onClick={() => {
                  confirming.current = false;
                  setPending(undefined);
                }}
              >
                {t("prompt.cancel")}
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {t("scm.continue")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
});
