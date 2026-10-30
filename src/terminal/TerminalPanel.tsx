import { createPortal } from "react-dom";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Settings } from "../settings/settings";
import { selectedTheme } from "../settings/theme";
import { desktop, native } from "../lib/native";
import { describeError, t } from "../lib/i18n";
import type { ShellProfile } from "./types";
import { createSession, type TerminalSession } from "./session";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export interface TerminalActions {
  create: () => void;
  focus: () => void;
}

function TerminalSurface({
  session,
  visible,
  settings,
}: {
  session: TerminalSession;
  visible: boolean;
  settings: Settings;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    session.terminal.open(element.current!);
    return () => {
      element.current?.replaceChildren();
    };
  }, [session]);
  useEffect(() => {
    const colors = selectedTheme(settings).colors;
    session.terminal.options.theme = {
      background: colors["terminal.background"],
      foreground: colors["terminal.foreground"],
      cursor: colors["terminalCursor.foreground"],
      selectionBackground: colors["terminal.selectionBackground"],
      black: colors["terminal.ansiBlack"],
      red: colors["terminal.ansiRed"],
      green: colors["terminal.ansiGreen"],
      yellow: colors["terminal.ansiYellow"],
      blue: colors["terminal.ansiBlue"],
      magenta: colors["terminal.ansiMagenta"],
      cyan: colors["terminal.ansiCyan"],
      white: colors["terminal.ansiWhite"],
      brightBlack: colors["terminal.ansiBrightBlack"],
      brightRed: colors["terminal.ansiBrightRed"],
      brightGreen: colors["terminal.ansiBrightGreen"],
      brightYellow: colors["terminal.ansiBrightYellow"],
      brightBlue: colors["terminal.ansiBrightBlue"],
      brightMagenta: colors["terminal.ansiBrightMagenta"],
      brightCyan: colors["terminal.ansiBrightCyan"],
      brightWhite: colors["terminal.ansiBrightWhite"],
    };
    session.terminal.options.fontFamily = settings.fontFamily;
    session.terminal.options.fontSize = settings.fontSize;
  }, [session, settings]);
  useEffect(() => {
    if (!visible) return;
    let frame = 0;

    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (element.current?.clientHeight && element.current.clientWidth)
          session.fit.fit();
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element.current!);
    fit();
    if (!document.activeElement?.closest("[role=tablist]"))
      session.terminal.focus();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [session, visible, settings.fontFamily, settings.fontSize]);
  return (
    <div
      ref={element}
      className="terminal-surface"
      hidden={!visible}
      aria-label={t("terminal.session", {
        shell: session.shell.id,
        number: session.key,
      })}
    />
  );
}

export const TerminalPanel = forwardRef<
  TerminalActions,
  {
    root?: string;
    visible: boolean;
    settings: Settings;
    controls: HTMLElement | null;
  }
>(function TerminalPanel({ root, visible, settings, controls }, ref) {
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [profile, setProfile] = useState("");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [active, setActive] = useState<number>();
  const [error, setError] = useState("");
  const all = useRef<TerminalSession[]>([]);
  const next = useRef(0);
  const live = useRef(true);
  const [revision, redraw] = useState(0);
  useEffect(() => {
    live.current = true;
    if (desktop)
      void native
        .terminalShells()
        .then((shells) => {
          if (!live.current) return;
          setProfiles(shells);
          setProfile(shells[0]?.id ?? "");
        })
        .catch((error) => {
          if (live.current) setError(describeError(error));
        });
    return () => {
      live.current = false;
      for (const session of all.current)
        void session.stop().catch(() => undefined);
      all.current = [];
    };
  }, []);

  const create = () => {
    const shell = profiles.find((candidate) => candidate.id === profile);
    if (!shell || all.current.length >= 8) return;
    setError("");
    const session = createSession(
      ++next.current,
      shell,
      root,
      () => {
        if (live.current) redraw((value) => value + 1);
      },
      (failure) => {
        if (live.current)
          setError(
            typeof failure === "string" ? failure : describeError(failure)
          );
      }
    );
    all.current = [...all.current, session];
    setSessions(all.current);
    setActive(session.key);
  };
  useImperativeHandle(ref, () => ({
    create,
    focus: () =>
      all.current.find((session) => session.key === active)?.terminal.focus(),
  }));
  const current = sessions.find((session) => session.key === active);

  const close = (session: TerminalSession) => {
    void session.stop().catch((failure) => setError(describeError(failure)));
    all.current = all.current.filter((candidate) => candidate !== session);
    setSessions(all.current);
    if (session === current) setActive(all.current.at(-1)?.key);
  };
  return (
    <section
      className="terminal-panel"
      aria-label={t("terminal.title")}
      data-revision={revision}
    >
      {controls &&
        createPortal(
          <div className="terminal-toolbar">
            <select
              aria-label={t("terminal.shell")}
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.path} value={profile.id}>
                  {profile.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!desktop || !profile || sessions.length >= 8}
              onClick={create}
              title={t("terminal.new")}
              aria-label={t("terminal.new")}
            >
              +
            </button>
            {sessions.length > 0 && (
              <>
                <select
                  aria-label={t("terminal.sessions")}
                  value={active}
                  onChange={(event) => setActive(Number(event.target.value))}
                >
                  {sessions.map((session) => (
                    <option key={session.key} value={session.key}>
                      {t("terminal.session", {
                        shell: session.shell.id,
                        number: session.key,
                      })}
                      {session.exited ? ` (${t("terminal.stopped")})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!current}
                  aria-label={t("terminal.kill")}
                  title={t("terminal.kill")}
                  onClick={() => current && close(current)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6m2-6v6" />
                  </svg>
                </button>
              </>
            )}
          </div>,
          controls
        )}
      {error && (
        <div className="terminal-error" role="alert">
          {error}
          <button
            type="button"
            aria-label={t("command.dismiss")}
            onClick={() => setError("")}
          >
            ×
          </button>
        </div>
      )}
      {current?.info && (
        <div className="terminal-cwd" title={current.info.cwd}>
          {t("terminal.cwd", { path: current.info.cwd })}
        </div>
      )}
      {!sessions.length && (
        <p className="terminal-empty">
          {t(
            desktop
              ? profiles.length
                ? "terminal.empty"
                : "terminal.noShells"
              : "editor.desktopRequired"
          )}
        </p>
      )}
      {sessions.map((session) => (
        <TerminalSurface
          key={session.key}
          session={session}
          settings={settings}
          visible={visible && active === session.key}
        />
      ))}
    </section>
  );
});
