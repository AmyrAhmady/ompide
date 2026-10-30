import { useEffect, useRef, useState } from "react";
import {
  type AppCommand,
  executeCommand,
  filterCommands,
} from "../app/commands";
import { workbench } from "../app/workbench";
import { t } from "../lib/i18n";
import { Modal } from "./Modal";

export function CommandPalette({
  commands,
  close,
}: {
  commands: AppCommand[];
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const pending = useRef<AppCommand | undefined>(undefined);
  const list = useRef<HTMLUListElement>(null);
  const results = filterCommands(commands, query);
  const enabled = results.filter((command) => command.enabled);
  const current = enabled[Math.min(selected, Math.max(0, enabled.length - 1))];

  useEffect(
    () => () => {
      const command = pending.current;
      // Execute after the dialog has fully closed, so actions can focus editors or
      // show another modal without native dialog focus restoration overriding them.
      if (command)
        requestAnimationFrame(() => executeCommand(command, workbench.report));
    },
    []
  );

  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current?.label]);

  const choose = (command: AppCommand) => {
    if (!command.enabled) return;
    pending.current = command;
    close();
  };
  return (
    <Modal label={t("command.palette")} onCancel={close}>
      <div className="command-palette">
        <h2>{t("command.palette")}</h2>
        <input
          autoFocus
          className="symbol-query"
          role="combobox"
          aria-label={t("palette.query")}
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={
            current ? `palette-${current.label}` : undefined
          }
          value={query}
          maxLength={256}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              if (
                (event.key === "Home" || event.key === "End") &&
                !event.ctrlKey
              )
                return;
              event.preventDefault();
              if (event.key === "Home") setSelected(0);
              else if (event.key === "End")
                setSelected(Math.max(0, enabled.length - 1));
              else
                setSelected((index) =>
                  enabled.length
                    ? (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        enabled.length) %
                      enabled.length
                    : 0
                );
            } else if (event.key === "Enter" && current) {
              event.preventDefault();
              choose(current);
            }
          }}
        />
        <ul
          ref={list}
          id="command-palette-results"
          role="listbox"
          aria-label={t("palette.results")}
        >
          {results.map((command) => (
            <li
              key={command.label}
              id={`palette-${command.label}`}
              role="option"
              aria-selected={command === current}
              aria-disabled={!command.enabled}
            >
              <button
                type="button"
                disabled={!command.enabled}
                tabIndex={-1}
                onClick={() => choose(command)}
              >
                <span>{t(command.label)}</span>
                <kbd>{command.shortcut}</kbd>
                {!command.enabled && <small>{t("palette.unavailable")}</small>}
              </button>
            </li>
          ))}
        </ul>
        {!results.length && (
          <p role="status" className="muted">
            {t("palette.empty")}
          </p>
        )}
        <footer>
          <button type="button" onClick={close}>
            {t("prompt.cancel")}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
