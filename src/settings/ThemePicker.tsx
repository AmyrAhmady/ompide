import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../components/Modal";
import { workbench } from "../app/workbench";
import { describeError, t } from "../lib/i18n";
import {
  defaultThemes,
  parseThemeText,
  ThemeError,
  themeSizeLimit,
  type Theme,
} from "./theme";
import {
  packageSizeLimit,
  themesFromFiles,
  unpackThemes,
  type InstalledTheme,
} from "./theme-package";
import {
  downloadThemes,
  searchThemes,
  type RegistryTheme,
} from "./theme-registry";

interface Choice {
  id: string;
  theme: Theme;
  builtIn?: "light" | "dark";
  installed?: InstalledTheme;
}

export function ThemePicker({ close }: { close: () => void }) {
  const initial = useRef(workbench.getSnapshot().settings).current;
  const customMatch = useMemo(() => {
    const snapshot = JSON.stringify(initial.customTheme);
    return initial.installedThemes.findIndex(
      (entry) => JSON.stringify(entry.theme) === snapshot
    );
  }, [initial]);
  const hasCustomSnapshot = Boolean(initial.customTheme && customMatch < 0);
  const [query, setQuery] = useState("");
  const [imported, setImported] = useState<InstalledTheme[]>([]);
  const [registry, setRegistry] = useState<RegistryTheme[]>([]);
  const [selected, setSelected] = useState(
    initial.theme === "custom"
      ? 2 + Math.max(0, customMatch)
      : initial.theme === "light"
        ? 1
        : 0
  );
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const file = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const allChoices: Choice[] = [
    ...Object.entries(defaultThemes).map(([id, theme]) => ({
      id,
      theme,
      builtIn: id as "light" | "dark",
    })),
    ...(hasCustomSnapshot && initial.customTheme
      ? [{ id: "custom", theme: initial.customTheme }]
      : []),
    ...[...imported, ...initial.installedThemes]
      .filter((entry) => !removed.includes(entry.id))
      .map((installed) => ({
        id: installed.id,
        theme: installed.theme,
        installed,
      })),
  ];
  const choices = allChoices
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.id === item.id) === index
    )
    .filter((item) =>
      `${item.theme.name} ${item.installed?.publisher ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  const activeIndex = Math.min(selected, Math.max(0, choices.length - 1));
  const current = choices[activeIndex];

  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
      void workbench.previewTheme().catch(workbench.report);
    },
    []
  );

  useEffect(() => {
    if (!online && current)
      void workbench.previewTheme(current.theme).catch(workbench.report);
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current?.id, current?.theme, online]);

  const choose = async (item: Choice) => {
    if (busy) return;
    setBusy(true);
    try {
      const settings = workbench.getSnapshot().settings;
      const additions = item.installed
        ? imported.filter((entry) => !removed.includes(entry.id))
        : [];
      const installedThemes = [
        ...settings.installedThemes.filter(
          (other) => !additions.some((entry) => entry.id === other.id)
        ),
        ...additions,
      ];
      if (
        installedThemes.length > 64 ||
        JSON.stringify(installedThemes).length > 8 * 1024 * 1024
      )
        throw new ThemeError("themeLibrarySize");
      await workbench.settings(
        item.builtIn
          ? { theme: item.builtIn }
          : { theme: "custom", customTheme: item.theme, installedThemes }
      );
      close();
    } catch (error) {
      setError(describeError(error));
      setBusy(false);
    }
  };

  const load = async (files: FileList, directory = false) => {
    const id = ++generation.current;
    request.current?.abort();
    setBusy(true);
    setError(undefined);
    try {
      const entries = [...files];
      if (
        entries.length > 10000 ||
        entries.reduce((size, item) => size + item.size, 0) > packageSizeLimit
      )
        throw new ThemeError("themeSize");
      let themes: InstalledTheme[];
      if (directory) {
        const texts = new Map<string, string>();
        for (const item of entries.filter((item) =>
          /\.(jsonc?|tmTheme)$/i.test(item.name)
        )) {
          if (item.size > themeSizeLimit) throw new ThemeError("themeSize");
          texts.set(
            item.webkitRelativePath.split("/").slice(1).join("/"),
            await item.text()
          );
        }
        themes = themesFromFiles(texts, "package.json");
      } else if (entries[0]?.name.toLowerCase().endsWith(".vsix")) {
        themes = await unpackThemes(
          new Uint8Array(await entries[0].arrayBuffer())
        );
      } else {
        if (!entries[0] || entries[0].size > themeSizeLimit)
          throw new ThemeError("themeSize");
        const theme = parseThemeText(await entries[0].text());
        themes = [{ id: `local:${theme.name}`, theme }];
      }
      if (!themes.length) throw new ThemeError("themePackage");
      if (generation.current !== id) return;
      setImported(themes);
      setQuery("");
      setOnline(false);
      setSelected(2 + (hasCustomSnapshot ? 1 : 0));
    } catch (error) {
      if (generation.current === id) setError(describeError(error));
    } finally {
      if (generation.current === id) setBusy(false);
    }
  };

  const search = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const id = ++generation.current;
    setBusy(true);
    setError(undefined);
    setOnline(true);
    try {
      const results = await searchThemes(query, controller.signal);
      if (generation.current === id) setRegistry(results);
    } catch (error) {
      if (!controller.signal.aborted && generation.current === id)
        setError(describeError(error));
    } finally {
      if (generation.current === id) setBusy(false);
    }
  };

  const download = async (item: RegistryTheme) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const id = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const themes = await downloadThemes(item, controller.signal);
      if (generation.current !== id) return;
      if (!themes.length) throw new ThemeError("themePackage");
      setImported(themes);
      setQuery("");
      setOnline(false);
      setSelected(2 + (hasCustomSnapshot ? 1 : 0));
    } catch (error) {
      if (!controller.signal.aborted && generation.current === id)
        setError(describeError(error));
    } finally {
      if (generation.current === id) setBusy(false);
    }
  };

  return (
    <Modal
      label={t("theme.select")}
      className="theme-picker-dialog"
      onCancel={close}
    >
      <h2>{t("theme.select")}</h2>
      <input
        autoFocus
        className="symbol-query"
        role="combobox"
        aria-label={t("theme.query")}
        aria-expanded="true"
        aria-controls="theme-options"
        aria-activedescendant={
          !online && current ? `theme-option-${activeIndex}` : undefined
        }
        value={query}
        maxLength={256}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (online) {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) =>
              choices.length
                ? (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    choices.length) %
                  choices.length
                : 0
            );
          } else if (event.key === "Enter" && current) {
            event.preventDefault();
            void choose(current);
          }
        }}
      />
      <div className="settings-tool-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOnline(false);
            setSelected(0);
          }}
        >
          {t("theme.installed")}
        </button>
        <button type="button" disabled={busy} onClick={() => void search()}>
          {t("theme.searchOnline")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          {t("theme.import")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => folder.current?.click()}
        >
          {t("theme.importFolder")}
        </button>
      </div>
      <input
        ref={file}
        type="file"
        hidden
        accept=".json,.jsonc,.vsix"
        aria-label={t("theme.file")}
        onChange={(event) => {
          if (event.target.files?.length) void load(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={(element) => {
          folder.current = element;
          element?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        hidden
        multiple
        aria-label={t("theme.folder")}
        onChange={(event) => {
          if (event.target.files?.length) void load(event.target.files, true);
          event.target.value = "";
        }}
      />
      <div
        className="theme-options"
        ref={list}
        id="theme-options"
        role="listbox"
        aria-label={t("theme.results")}
        aria-busy={busy}
      >
        {!online &&
          choices.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              id={`theme-option-${index}`}
              aria-selected={item === current}
              disabled={busy}
              onFocus={() => setSelected(index)}
              onMouseEnter={() => setSelected(index)}
              onClick={() => void choose(item)}
            >
              <span
                className="theme-swatch"
                style={{
                  backgroundColor: item.theme.colors["editor.background"],
                  color: item.theme.colors["editor.foreground"],
                }}
                aria-hidden="true"
              >
                Aa
              </span>
              <span>
                {item.theme.name}
                <small>
                  {item.installed?.publisher ??
                    t(item.builtIn ? "theme.builtin" : "theme.local")}
                </small>
              </span>
              {item.installed?.license && (
                <small>{item.installed.license}</small>
              )}
            </button>
          ))}
        {online &&
          registry.map((item) => (
            <button
              type="button"
              key={`${item.namespace}.${item.name}`}
              disabled={busy}
              onClick={() => void download(item)}
            >
              <span>
                {item.displayName}
                <small>
                  {item.namespace} · {item.version}
                </small>
              </span>
              <span>{t("theme.download")}</span>
            </button>
          ))}
      </div>
      <p className="muted" role="status">
        {t(
          busy
            ? "theme.loading"
            : online
              ? "theme.onlineHelp"
              : choices.length
                ? "theme.previewHelp"
                : "theme.empty"
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button
          type="button"
          disabled={busy || !current?.installed || online}
          onClick={() => {
            if (!current?.installed) return;
            const id = current.id;
            setRemoved((ids) => [...ids, id]);
            setSelected(0);
            void workbench
              .settings({
                installedThemes: workbench
                  .getSnapshot()
                  .settings.installedThemes.filter((entry) => entry.id !== id),
              })
              .catch(workbench.report);
          }}
        >
          {t("theme.remove")}
        </button>
        <button type="button" onClick={close}>
          {t("prompt.cancel")}
        </button>
      </footer>
    </Modal>
  );
}
