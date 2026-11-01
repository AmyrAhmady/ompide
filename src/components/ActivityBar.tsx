import { t } from "../lib/i18n";
import type { Layout } from "../settings/layout";
import { Icon } from "./Icon";

const views = [
  {
    id: "explorer",
    label: "explorer.title",
    icon: "files",
  },
  {
    id: "search",
    label: "search.title",
    icon: "search",
  },
  {
    id: "sourceControl",
    label: "scm.title",
    icon: "sourceControl",
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
          <Icon name={view.icon} size={24} />
        </button>
      ))}
    </nav>
  );
}
