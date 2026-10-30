import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { native } from "../lib/native";
import { t } from "../lib/i18n";
import type { ShellProfile, TerminalInfo } from "./types";

export interface TerminalSession {
  key: number;
  shell: ShellProfile;
  terminal: Terminal;
  fit: FitAddon;
  info?: TerminalInfo;
  exited: boolean;
  disposed: boolean;
  stop: () => Promise<void>;
}

/** Own one emulator and its native transport independently of React renders. */
export function createSession(
  key: number,
  shell: ShellProfile,
  root: string | undefined,
  changed: () => void,
  report: (failure: unknown) => void
): TerminalSession {
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: false,
    allowTransparency: false,
    // No OSC clipboard integration or link handler: output cannot run actions.
    screenReaderMode: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  let pendingAcknowledgement = 0;
  let inputQueue = Promise.resolve();
  let queuedBytes = 0;
  let queuedPackets = 0;
  const session: TerminalSession = {
    key,
    shell,
    terminal,
    fit,
    exited: false,
    disposed: false,
    stop: async () => {
      session.disposed = true;
      terminal.dispose();
      const info = await started.catch(() => undefined);
      if (info) await native.terminalClose(info.id);
    },
  };

  const fail = (failure: unknown) => {
    if (!session.disposed) report(failure);
  };

  const acknowledge = (sequence: number) => {
    pendingAcknowledgement = Math.max(sequence, pendingAcknowledgement);
    if (session.info && !session.disposed)
      void native
        .terminalAcknowledge(session.info.id, pendingAcknowledgement)
        .catch(fail);
  };

  const write = (data: string) => {
    if (session.exited || session.disposed) return;
    const bytes = new TextEncoder().encode(data);
    if (queuedBytes + bytes.length > 1024 * 1024 || queuedPackets >= 256) {
      fail({ code: "terminalInput" });
      return;
    }
    queuedBytes += bytes.length;
    queuedPackets++;
    inputQueue = inputQueue
      .then(async () => {
        const info = await started;
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          if (session.disposed || session.exited) break;
          await native.terminalWrite(
            info.id,
            Array.from(bytes.subarray(offset, offset + 16384))
          );
        }
      })
      .catch(fail)
      .finally(() => {
        queuedBytes -= bytes.length;
        queuedPackets--;
      });
  };
  terminal.onData(write);
  terminal.onResize(({ cols, rows }) => {
    if (session.info && !session.disposed && !session.exited)
      void native.terminalResize(session.info.id, cols, rows).catch(fail);
  });
  terminal.attachCustomKeyEventHandler((event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return true;
    if (event.code === "KeyC") {
      if (event.type === "keydown" && terminal.hasSelection())
        void navigator.clipboard.writeText(terminal.getSelection()).catch(fail);
      event.preventDefault();
      return false;
    }
    if (event.code === "KeyV") {
      if (event.type === "keydown")
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (session.disposed) return;
            // xterm's paste handles bracketed paste and neutralizes escape sequences.
            terminal.paste(text);
          })
          .catch(fail);
      event.preventDefault();
      return false;
    }
    return true;
  });
  const started = native.terminalStart(
    shell.id,
    root ?? null,
    80,
    24,
    (event) => {
      if (session.disposed) return;
      if (event.kind === "data")
        terminal.write(new Uint8Array(event.data), () =>
          acknowledge(event.sequence)
        );
      else if (event.kind === "exit") {
        session.exited = true;
        terminal.options.disableStdin = true;
        terminal.write(
          `\r\n${t("terminal.exited", { code: event.code ?? "?" })}\r\n`
        );
        changed();
      } else {
        report(t("terminal.streamError", { detail: event.detail }));
      }
    }
  );
  void started
    .then((info) => {
      session.info = info;
      if (session.disposed) return;
      acknowledge(pendingAcknowledgement);
      void native
        .terminalResize(info.id, terminal.cols, terminal.rows)
        .catch(fail);
      changed();
    })
    .catch((failure) => {
      session.exited = true;
      terminal.options.disableStdin = true;
      fail(failure);
      changed();
    });
  return session;
}
