import { type MouseEvent, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { desktop } from "../lib/native";
import {
  openProjectLink,
  projectLinks,
  type ProjectLink,
} from "../lib/project-links";
import { workbench } from "../app/workbench";
import { Modal } from "./Modal";
import { AppLogo } from "./AppLogo";

function CreditLink({
  link,
  children,
}: {
  link: ProjectLink;
  children: ReactNode;
}) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!desktop) return;
    event.preventDefault();
    void openProjectLink(link).catch(workbench.report);
  };

  return (
    <a
      href={projectLinks[link]}
      target="_blank"
      rel="noopener noreferrer"
      onClick={open}
    >
      {children}
    </a>
  );
}

export function CreditsDialog({ close }: { close: () => void }) {
  return (
    <Modal
      label={t("help.credits")}
      onCancel={close}
      className="credits-dialog"
    >
      <h2>{t("help.credits")}</h2>
      <div className="credits-brand">
        <AppLogo size={48} decorative />
        <p className="credits-name">{t("app.name")}</p>
      </div>
      <p>{t("help.description")}</p>
      <p>{t("help.createdBy", { name: t("help.author") })}</p>
      <p>
        <CreditLink link="author">{t("help.authorGithub")}</CreditLink>
      </p>
      <p>{t("help.builtWith")}</p>
      <p>{t("help.support")}</p>
      <p>
        <CreditLink link="donate">{t("help.donate")}</CreditLink>
      </p>
      <footer>
        <button type="button" onClick={close}>
          {t("help.close")}
        </button>
      </footer>
    </Modal>
  );
}
