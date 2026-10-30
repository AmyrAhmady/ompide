import { useEffect, useRef, useState } from "react";
import { workbench } from "../app/workbench";
import { describeError, t } from "../lib/i18n";
import type { Settings } from "./settings";
import {
  parseThemeText,
  selectedTheme,
  ThemeError,
  themeSizeLimit,
} from "./theme";

export function ThemeSettings({ settings }: { settings: Settings }) {
  const input = useRef<HTMLInputElement>(null);
  const customize = useRef<HTMLButtonElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const generation = useRef(0);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (error) alert.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );

  const cancel = () => {
    generation.current++;
    setDraft(undefined);
    setError(undefined);
    requestAnimationFrame(() => customize.current?.focus());
  };

  const load = async (file: File) => {
    const current = ++generation.current;
    setError(undefined);
    try {
      if (file.size > themeSizeLimit) throw new ThemeError("themeSize");
      const text = await file.text();
      if (generation.current !== current) return;
      const theme = parseThemeText(text);
      setDraft(JSON.stringify(theme, null, 2));
    } catch (error) {
      if (generation.current === current)
        setError(
          error instanceof ThemeError
            ? describeError(error)
            : t("error.themeRead")
        );
    }
  };

  const apply = async () => {
    if (draft === undefined || busy) return;
    setError(undefined);
    try {
      const customTheme = parseThemeText(draft);
      setBusy(true);
      await workbench.settings({ theme: "custom", customTheme });
      cancel();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="theme-settings">
      <div className="settings-tool-actions">
        <button
          type="button"
          ref={customize}
          disabled={busy}
          onClick={() => {
            generation.current++;
            const theme = selectedTheme(settings);
            setDraft(
              JSON.stringify(
                {
                  ...theme,
                  name:
                    settings.theme === "custom"
                      ? theme.name
                      : t("theme.newName"),
                },
                null,
                2
              )
            );
            setError(undefined);
          }}
        >
          {t("theme.customize")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {t("theme.load")}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".json,application/json"
          aria-label={t("theme.file")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void load(file);
          }}
        />
      </div>
      {draft !== undefined && (
        <div className="theme-editor">
          <p id="theme-help">{t("theme.help")}</p>
          <label htmlFor="theme-json">{t("theme.json")}</label>
          <textarea
            id="theme-json"
            autoFocus
            value={draft}
            spellCheck={false}
            maxLength={themeSizeLimit}
            rows={14}
            disabled={busy}
            aria-describedby="theme-help"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="settings-tool-actions">
            <button type="button" disabled={busy} onClick={() => void apply()}>
              {t("theme.apply")}
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              {t("theme.cancel")}
            </button>
          </div>
          <p>{t("theme.saved")}</p>
        </div>
      )}
      {error && (
        <p ref={alert} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
