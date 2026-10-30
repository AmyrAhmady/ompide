import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Uri } from "monaco-editor";
import { workbench } from "../app/workbench";
import type { Entry } from "../lib/native";
import { describeError, t, type TranslationKey } from "../lib/i18n";
import {
  childPath,
  fileName,
  parentPath,
  pathKey,
  withinPath,
} from "../lib/paths";
import { Modal } from "../components/Modal";

type Action = "file" | "folder" | "rename" | "trash";
type Request = { action: Action; entry: Entry };
type Listing = { revision: number; entries: Entry[]; error?: string };
type Row = { entry: Entry; depth: number; position: number; total: number };
type Context = { entry: Entry; x: number; y: number };

const actionLabels: Record<Action, TranslationKey> = {
  file: "explorer.newFile",
  folder: "explorer.newFolder",
  rename: "explorer.rename",
  trash: "explorer.trash",
};

function EntryDialog({
  request,
  close,
  completed,
}: {
  request: Request;
  close: () => void;
  completed: (path: string) => void;
}) {
  const { action, entry } = request;
  const [name, setName] = useState(action === "rename" ? entry.name : "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (action === "file" || action === "folder") {
        completed(
          await workbench.createEntry(entry.path, name, action === "folder")
        );
      } else if (
        await workbench.changeEntry(
          entry.path,
          action === "rename" ? name : undefined
        )
      ) {
        completed(
          action === "rename"
            ? childPath(parentPath(entry.path), name)
            : parentPath(entry.path)
        );
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      label={t(actionLabels[action])}
      onCancel={() => {
        if (!busy) close();
      }}
    >
      <form
        className="entry-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <h2>{t(actionLabels[action])}</h2>
        {action === "trash" ? (
          <p>
            {t(
              entry.directory
                ? "explorer.confirmTrashFolder"
                : "explorer.confirmTrashFile",
              { name: entry.name }
            )}
          </p>
        ) : (
          <label>
            {t("explorer.name")}
            <input
              ref={input}
              value={name}
              disabled={busy}
              required
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <p className="muted entry-location" title={entry.path}>
          {entry.path}
        </p>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">{t("explorer.working")}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            {t("prompt.cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || (action !== "trash" && !name.trim())}
          >
            {t(
              action === "trash"
                ? "explorer.trashConfirm"
                : action === "rename"
                  ? "explorer.renameConfirm"
                  : "explorer.create"
            )}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ContextMenu({
  context,
  root,
  disabled,
  close,
  choose,
  open,
}: {
  context: Context;
  root: string;
  disabled: boolean;
  close: (restore?: boolean) => void;
  choose: (action: Action) => void;
  open: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button:enabled")?.focus();

    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };

    const hide = () => close();
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", hide);
    };
  }, [close]);

  const navigate = (event: KeyboardEvent) => {
    const buttons = [
      ...menu.current!.querySelectorAll<HTMLButtonElement>("button:enabled"),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close(true);
    }
  };
  return (
    <div
      ref={menu}
      className="explorer-context"
      role="menu"
      aria-label={t("explorer.actions")}
      onKeyDown={navigate}
      style={{
        left: Math.max(0, Math.min(context.x, window.innerWidth - 225)),
        top: Math.max(0, Math.min(context.y, window.innerHeight - 215)),
      }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={context.entry.symlink}
        onClick={open}
      >
        {t("explorer.open")}
      </button>
      {context.entry.directory &&
        (["file", "folder"] as const).map((action) => (
          <button
            key={action}
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => choose(action)}
          >
            {t(actionLabels[action])}
          </button>
        ))}
      {pathKey(context.entry.path) !== pathKey(root) && (
        <>
          <hr />
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => choose("rename")}
          >
            {t("explorer.rename")}
            <kbd>F2</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => choose("trash")}
          >
            {t("explorer.trash")}
            <kbd>Delete</kbd>
          </button>
        </>
      )}
    </div>
  );
}

function ExplorerView({
  root,
  active,
  revision,
  reveal,
  busy,
  refresh,
}: {
  root?: string;
  active?: string;
  revision: number;
  reveal: number;
  busy: boolean;
  refresh: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const cache = useRef(listings);
  const [selected, setSelected] = useState<string>();
  const [context, setContext] = useState<Context>();
  const [request, setRequest] = useState<Request>();
  const tree = useRef<HTMLUListElement>(null);
  const focusTarget = useRef<string | undefined>(undefined);
  const focusAfterDialog = useRef<
    "editor" | "create" | { path: string } | undefined
  >(undefined);
  const createButton = useRef<HTMLButtonElement>(null);
  const typeAhead = useRef({ text: "", until: 0 });
  const activePath = active?.startsWith("file:")
    ? Uri.parse(active).fsPath
    : undefined;

  useEffect(() => {
    const target = focusAfterDialog.current;
    if (request || !target) return;
    // Run after the native dialog's unmount cleanup restores its previous focus.
    const frame = requestAnimationFrame(() => {
      focusAfterDialog.current = undefined;
      if (target === "editor") workbench.focusEditor();
      else if (target === "create") createButton.current?.focus();
      else focus(target.path);
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  useEffect(() => {
    if (!root) return;
    let live = true;
    for (const path of [root, ...expanded]) {
      if (cache.current.get(pathKey(path))?.revision === revision) continue;
      void workbench
        .entries(path)
        .then((entries) => {
          if (!live) return;
          const next = new Map(cache.current);
          next.set(pathKey(path), { revision, entries });
          cache.current = next;
          setListings(next);
        })
        .catch((failure) => {
          if (!live) return;
          const next = new Map(cache.current);
          next.set(pathKey(path), {
            revision,
            entries: [],
            error: describeError(failure),
          });
          cache.current = next;
          setListings(next);
        });
    }
    return () => {
      live = false;
    };
  }, [root, expanded, revision]);

  const focus = (path: string) => {
    const key = pathKey(path);
    setSelected(key);
    const element = [
      ...(tree.current?.querySelectorAll<HTMLButtonElement>(
        "[role=treeitem]"
      ) ?? []),
    ].find((button) => button.dataset.path === key);
    if (element) {
      element.focus();
      element.scrollIntoView({ block: "nearest" });
      focusTarget.current = undefined;
    } else focusTarget.current = key;
  };

  const revealPath = (path: string, takeFocus = true) => {
    if (!root || !withinPath(path, root)) return;
    const parents: string[] = [];
    let parent = parentPath(path);
    while (withinPath(parent, root) && pathKey(parent) !== pathKey(root)) {
      parents.push(pathKey(parent));
      const next = parentPath(parent);
      if (next === parent) break;
      parent = next;
    }
    setExpanded((current) => new Set([...current, ...parents]));
    if (takeFocus) requestAnimationFrame(() => focus(path));
    else {
      focusTarget.current = undefined;
      setSelected(pathKey(path));
    }
  };

  useEffect(() => {
    if (reveal && activePath && root && withinPath(activePath, root))
      revealPath(activePath);
    else if (reveal)
      tree.current
        ?.querySelector<HTMLButtonElement>("[role=treeitem]")
        ?.focus();
    // Reveal is an explicit command; tab changes alone do not expand folders.
  }, [reveal]);

  useEffect(() => {
    if (focusTarget.current) focus(focusTarget.current);
  }, [listings, expanded]);

  const rootEntry: Entry | undefined = root
    ? { name: fileName(root), path: root, directory: true, symlink: false }
    : undefined;
  const rows: Row[] = [];

  const collect = (directory: string, depth: number) => {
    const entries = listings.get(pathKey(directory))?.entries ?? [];
    entries.forEach((entry, index) => {
      rows.push({ entry, depth, position: index + 1, total: entries.length });
      if (entry.directory && expanded.has(pathKey(entry.path)))
        collect(entry.path, depth + 1);
    });
  };
  if (root) collect(root, 0);
  const selectedVisible = rows.some(
    ({ entry }) => pathKey(entry.path) === selected
  );
  const selectedEntry = rows.find(
    ({ entry }) => pathKey(entry.path) === selected
  )?.entry;
  const parent = selectedEntry?.directory
    ? selectedEntry
    : rootEntry && {
        ...rootEntry,
        path: selectedEntry ? parentPath(selectedEntry.path) : rootEntry.path,
      };
  const activeInside = Boolean(
    root &&
    activePath &&
    withinPath(activePath, root) &&
    pathKey(activePath) !== pathKey(root)
  );

  const toggle = (entry: Entry, open?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(pathKey(entry.path))) next.add(pathKey(entry.path));
      else next.delete(pathKey(entry.path));
      return next;
    });
  };

  const open = (entry: Entry) => {
    if (entry.symlink) return;
    if (entry.directory) toggle(entry);
    else void workbench.openPath(entry.path).catch(workbench.report);
  };

  const choose = (action: Action, entry: Entry | undefined) => {
    setContext(undefined);
    if (entry && !busy && !entry.symlink) setRequest({ action, entry });
  };

  const openContext = (entry: Entry, x: number, y: number) => {
    setSelected(pathKey(entry.path));
    setContext({ entry, x, y });
  };

  const navigate = (event: KeyboardEvent, row: Row, index: number) => {
    const { entry } = row;
    const previous = rows[index - 1]?.entry;
    const next = rows[index + 1]?.entry;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        if (next) focus(next.path);
        break;
      case "ArrowUp":
        if (previous) focus(previous.path);
        break;
      case "Home":
        focus(rows[0].entry.path);
        break;
      case "End":
        focus(rows.at(-1)!.entry.path);
        break;
      case "ArrowRight":
        if (entry.directory && !entry.symlink) {
          if (!expanded.has(pathKey(entry.path))) toggle(entry, true);
          else if (next && withinPath(next.path, entry.path)) focus(next.path);
        }
        break;
      case "ArrowLeft":
        if (entry.directory && expanded.has(pathKey(entry.path)))
          toggle(entry, false);
        else if (root && pathKey(parentPath(entry.path)) !== pathKey(root))
          focus(parentPath(entry.path));
        break;
      case "Enter":
        open(entry);
        break;
      case " ":
        setSelected(pathKey(entry.path));
        break;
      case "F2":
        choose("rename", entry);
        break;
      case "Delete":
        choose("trash", entry);
        break;
      case "Insert":
        choose(event.shiftKey ? "folder" : "file", parent);
        break;
      case "ContextMenu":
      case "F10": {
        if (event.key === "F10" && !event.shiftKey) {
          handled = false;
          break;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        openContext(entry, rect.left + 20, rect.bottom);
        break;
      }
      default:
        if (
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          const prefix =
            (Date.now() < typeAhead.current.until
              ? typeAhead.current.text
              : "") + event.key.toLocaleLowerCase();
          typeAhead.current = { text: prefix, until: Date.now() + 800 };
          const match = [
            ...rows.slice(index + 1),
            ...rows.slice(0, index + 1),
          ].find(({ entry }) =>
            entry.name.toLocaleLowerCase().startsWith(prefix)
          );
          if (match) focus(match.entry.path);
        } else handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const rootListing = root ? listings.get(pathKey(root)) : undefined;
  return (
    <>
      <div className="panel-heading">
        <span>{t("explorer.title")}</span>
        <div className="explorer-tools">
          <button
            ref={createButton}
            type="button"
            aria-label={t("explorer.newFile")}
            title={t("explorer.newFile")}
            disabled={!parent || busy || parent.symlink}
            onClick={() => choose("file", parent)}
          >
            ＋
          </button>
          <button
            type="button"
            aria-label={t("explorer.newFolder")}
            title={t("explorer.newFolder")}
            disabled={!parent || busy || parent.symlink}
            onClick={() => choose("folder", parent)}
          >
            ▱+
          </button>
          <button
            type="button"
            aria-label={t("explorer.reveal")}
            title={t("explorer.reveal")}
            disabled={!activeInside}
            onClick={() => {
              if (activePath) revealPath(activePath);
            }}
          >
            ◎
          </button>
          <button
            type="button"
            aria-label={t("command.refresh")}
            title={t("command.refresh")}
            disabled={!root || busy}
            onClick={refresh}
          >
            ↻
          </button>
        </div>
      </div>
      {rootEntry ? (
        <>
          <div
            className="workspace-name"
            title={root}
            onContextMenu={(event) => {
              event.preventDefault();
              openContext(rootEntry, event.clientX, event.clientY);
            }}
          >
            {rootEntry.name}
          </div>
          {!rootListing ? (
            <p className="muted explorer-empty" role="status">
              {t("explorer.loading")}
            </p>
          ) : rootListing.error ? (
            <p className="explorer-empty" role="alert">
              {rootListing.error}
            </p>
          ) : (
            <>
              {!rows.length && (
                <p className="muted explorer-empty">{t("explorer.noFiles")}</p>
              )}
              <ul ref={tree} role="tree" aria-label={t("explorer.title")}>
                {rows.map((row, index) => {
                  const { entry, depth, position, total } = row;
                  const key = pathKey(entry.path);
                  const childListing = listings.get(key);
                  const isSelected =
                    selected === key ||
                    (!selected && activePath && pathKey(activePath) === key);
                  return (
                    <li key={entry.path} role="none">
                      <button
                        type="button"
                        role="treeitem"
                        className={`tree-row ${isSelected ? "selected" : ""}`}
                        data-path={key}
                        aria-level={depth + 1}
                        aria-posinset={position}
                        aria-setsize={total}
                        aria-expanded={
                          entry.directory
                            ? expanded.has(pathKey(entry.path))
                            : undefined
                        }
                        aria-selected={Boolean(isSelected)}
                        aria-disabled={entry.symlink}
                        tabIndex={
                          selectedVisible
                            ? selected === key
                              ? 0
                              : -1
                            : index === 0
                              ? 0
                              : -1
                        }
                        style={{ paddingLeft: 10 + depth * 14 }}
                        title={
                          entry.symlink
                            ? t("explorer.symbolicLink")
                            : entry.path
                        }
                        onFocus={() => setSelected(key)}
                        onClick={() => open(entry)}
                        onKeyDown={(event) => navigate(event, row, index)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openContext(entry, event.clientX, event.clientY);
                        }}
                      >
                        <span className="tree-chevron" aria-hidden="true">
                          {entry.directory
                            ? expanded.has(pathKey(entry.path))
                              ? "⌄"
                              : "›"
                            : ""}
                        </span>
                        <span className="file-icon" aria-hidden="true">
                          {entry.directory
                            ? "▱"
                            : entry.name.endsWith(".inc")
                              ? "#"
                              : "⋮"}
                        </span>
                        <span>{entry.name}</span>
                      </button>
                      {entry.directory &&
                        expanded.has(pathKey(entry.path)) &&
                        (!childListing || childListing.error) && (
                          <p
                            className="tree-notice"
                            role={childListing?.error ? "alert" : "status"}
                            style={{ paddingLeft: 24 + depth * 14 }}
                          >
                            {childListing?.error ?? t("explorer.loading")}
                          </p>
                        )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      ) : (
        <p className="muted explorer-empty">{t("explorer.empty")}</p>
      )}
      {context && root && (
        <ContextMenu
          context={context}
          root={root}
          disabled={busy || context.entry.symlink}
          close={(restore) => {
            setContext(undefined);
            if (restore) focus(context.entry.path);
          }}
          choose={(action) => choose(action, context.entry)}
          open={() => {
            setContext(undefined);
            open(context.entry);
          }}
        />
      )}
      {request && (
        <EntryDialog
          request={request}
          close={() => setRequest(undefined)}
          completed={(path) => {
            focusAfterDialog.current =
              request.action === "file" ? "editor" : { path };
            focusTarget.current = undefined;
            setRequest(undefined);
            if (request.action === "trash") {
              const index = rows.findIndex(
                ({ entry }) =>
                  pathKey(entry.path) === pathKey(request.entry.path)
              );
              const remaining = rows.filter(
                ({ entry }) => !withinPath(entry.path, request.entry.path)
              );
              const next = remaining[Math.min(index, remaining.length - 1)];
              if (next) {
                revealPath(next.entry.path, false);
                focusAfterDialog.current = { path: next.entry.path };
              } else {
                setSelected(undefined);
                focusAfterDialog.current = "create";
              }
            } else revealPath(path, false);
          }}
        />
      )}
    </>
  );
}

export const Explorer = memo(ExplorerView);
