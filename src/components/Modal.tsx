import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  children,
  label,
  onCancel,
}: {
  children: ReactNode;
  label: string;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      requestAnimationFrame(() => {
        // Removing a modal before close() can leave focus on body in WebView2.
        // Restore the original control only if an action has not focused another
        // control or opened another modal in the meantime.
        if (
          previous instanceof HTMLElement &&
          previous.isConnected &&
          document.activeElement === document.body &&
          !document.querySelector("dialog[open]")
        )
          previous.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {children}
    </dialog>
  );
}
