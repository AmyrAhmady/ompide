import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t, type TranslationKey } from '../lib/i18n';

const menus = (root: HTMLElement) => [...root.querySelectorAll<HTMLDetailsElement>('.menu')];
const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
const summary = (menu: HTMLElement) => menu.querySelector('summary');

function closeMenus(root: HTMLElement, restoreFocus = false): void {
  const opened = menus(root).find(menu => menu.open);
  for (const menu of menus(root)) menu.open = false;
  if (restoreFocus && opened) summary(opened)?.focus();
}

function focusItem(menu: HTMLDetailsElement, last = false): void {
  menu.open = true;
  const enabled = items(menu);
  (last ? enabled.at(-1) : enabled[0])?.focus();
}

/** One menu group, with dismissal and keyboard navigation shared by every dropdown. */
export function Menubar({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current!;
    const outside = (event: Event) => { if (event.target instanceof Node && !root.contains(event.target)) closeMenus(root); };
    const blur = () => closeMenus(root);
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && !['Control', 'Meta'].includes(event.key)) closeMenus(root); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', shortcut, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', shortcut, true);
    };
  }, []);

  return <nav ref={ref} aria-label={label} onKeyDown={event => {
    if (!(event.target instanceof HTMLElement)) return;
    const menu = event.target.closest<HTMLDetailsElement>('.menu');
    const root = ref.current!;
    if (!menu) return;
    const isSummary = event.target === summary(menu);
    if (event.key === 'Tab') { closeMenus(root, true); return; }
    if (event.key === 'Escape') closeMenus(root, true);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const all = menus(root);
      const next = all[(all.indexOf(menu) + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      const opened = all.some(menu => menu.open);
      summary(next)?.focus();
      if (opened) focusItem(next);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (isSummary) focusItem(menu, event.key === 'ArrowUp');
      else {
        const enabled = items(menu);
        const index = enabled.indexOf(event.target as HTMLButtonElement);
        enabled[(index + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]?.focus();
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      const targets = isSummary ? menus(root).map(summary) : items(menu);
      (event.key === 'Home' ? targets[0] : targets.at(-1))?.focus();
    } else if (isSummary && (event.key === 'Enter' || event.key === ' ')) {
      if (menu.open) closeMenus(root, true); else focusItem(menu);
    } else return;
    event.preventDefault(); event.stopPropagation();
  }}>{children}</nav>;
}

export function Menu({ label, children }: { label: TranslationKey; children: ReactNode }) {
  const id = useId();
  return <details className="menu" name="application-menu">
    <summary id={id} aria-haspopup="menu" aria-controls={`${id}-popup`} onPointerEnter={event => {
      const menu = event.currentTarget.parentElement as HTMLDetailsElement;
      if (!menu.open && menu.closest('nav')?.querySelector('.menu[open]')) {
        menu.open = true; event.currentTarget.focus({ preventScroll: true });
      }
    }}>{t(label)}</summary>
    <div id={`${id}-popup`} role="menu" aria-labelledby={id}>{children}</div>
  </details>;
}

export function MenuItem({ label, shortcut, action, disabled = false }: { label: TranslationKey; shortcut?: string; action: () => void; disabled?: boolean }) {
  return <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={event => {
    const menu = event.currentTarget.closest('details');
    if (menu) { menu.open = false; summary(menu)?.focus(); }
    action();
  }}><span>{t(label)}</span><kbd>{shortcut}</kbd></button>;
}
