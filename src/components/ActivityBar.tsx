import { t } from "../lib/i18n";
import type { Layout } from "../settings/layout";

const views = [
  {
    id: "explorer",
    label: "explorer.title",
    path: "M8 3h8l5 5v13H8z M3 7v14a3 3 0 0 0 3 3 M16 3v6h5",
  },
  {
    id: "search",
    label: "search.title",
    path: "M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  },
  {
    id: "sourceControl",
    label: "scm.title",
    path: "M6 8v8 M18 8v3a5 5 0 0 1-5 5H6 M9 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  },
] as const;

export function ActivityBar({
  layout,
  ready,
  select,
}: {
  layout: Layout;
  ready: boolean;
  select: (view: Layout["sidebar"]) => void;
}) {
  return (
    <nav
      className="activity-bar"
      aria-label={t("activity.title")}
      onKeyDown={(event) => {
        const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
        if (!keys.includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        ];
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      {views.map((view) => (
        <button
          type="button"
          key={view.id}
          title={t(view.label)}
          aria-label={t(view.label)}
          aria-controls="workspace-sidebar"
          aria-pressed={layout.sidebarVisible && layout.sidebar === view.id}
          disabled={!ready}
          onClick={() => select(view.id)}
        >
          <svg
            width="25"
            height="25"
            viewBox="0 0 26 26"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d={view.path} />
          </svg>
        </button>
      ))}
    </nav>
  );
}
