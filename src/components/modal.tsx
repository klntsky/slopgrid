import { useEffect, useRef, type ReactNode, type RefObject } from "react";

export function Modal({
  children,
  titleId,
  onClose,
  busy = false,
  className = "",
  ref: suppliedRef,
}: {
  children: ReactNode;
  titleId: string;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  ref?: RefObject<HTMLDialogElement | null>;
}) {
  const ownRef = useRef<HTMLDialogElement>(null);
  const ref = suppliedRef ?? ownRef;
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [ref]);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
