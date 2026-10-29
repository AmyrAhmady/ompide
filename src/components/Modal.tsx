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
    dialog?.showModal();
    return () => dialog?.close();
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
