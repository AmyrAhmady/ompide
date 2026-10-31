import { t } from "../lib/i18n";

export function AppLogo({
  size = 24,
  decorative = false,
}: {
  size?: 24 | 48 | 64;
  decorative?: boolean;
}) {
  const pixels = size === 24 ? 32 : size === 48 ? 64 : 128;
  return (
    <img
      className="app-logo"
      src={`/branding/ompide-${pixels}.png`}
      srcSet={`/branding/ompide-${pixels * 2}.png 2x`}
      width={size}
      height={size}
      alt={decorative ? "" : t("app.name")}
      draggable={false}
    />
  );
}
