import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { desktop } from "../lib/native";
import { t } from "../lib/i18n";
import { workbench } from "../app/workbench";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const remove: UnlistenFn[] = [];
    const window = getCurrentWindow();

    const own = async (subscription: Promise<UnlistenFn>) => {
      const unlisten = await subscription;
      if (disposed) unlisten();
      else remove.push(unlisten);
    };

    const refresh = () => {
      void window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(workbench.report);
    };
    refresh();
    void Promise.all([
      own(window.onResized(refresh)),
      own(window.onFocusChanged(({ payload }) => setFocused(payload))),
      own(listen("tauri-frame://snap/mouseenter", () => setHovered(true))),
      own(listen("tauri-frame://snap/mouseleave", () => setHovered(false))),
      own(
        listen("tauri-frame://snap/click", () => {
          void window.toggleMaximize().catch(workbench.report);
        })
      ),
    ]).catch(workbench.report);
    return () => {
      disposed = true;
      remove.forEach((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    document
      .querySelector<HTMLElement>(".ide-menubar")
      ?.classList.toggle("inactive", !focused);
  }, [focused]);
  if (!desktop) return null;
  const window = getCurrentWindow();
  return (
    <div
      className="window-controls"
      role="group"
      aria-label={t("window.controls")}
    >
      <button
        type="button"
        title={t("window.minimize")}
        aria-label={t("window.minimize")}
        onClick={() => void window.minimize().catch(workbench.report)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 6.5h10" />
        </svg>
      </button>
      <button
        type="button"
        className={hovered ? "snap-hover" : undefined}
        title={t(maximized ? "window.restore" : "window.maximize")}
        aria-label={t(maximized ? "window.restore" : "window.maximize")}
        onClick={() => void window.toggleMaximize().catch(workbench.report)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {maximized ? (
            <path d="M3.5 2.5v-1h7v7h-1M1.5 3.5h7v7h-7z" />
          ) : (
            <path d="M1.5 1.5h9v9h-9z" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="window-close"
        title={t("window.close")}
        aria-label={t("window.close")}
        onClick={() => void window.close().catch(workbench.report)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="m1.5 1.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>
  );
}
