import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

export function WorkspaceDialog({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = element.current;
    const priorFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (priorFocus instanceof HTMLElement && priorFocus.isConnected)
        priorFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={element}
      className={
        className ? `workspace-dialog ${className}` : "workspace-dialog"
      }
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button
          aria-label={`Close ${title}`}
          title="Close without applying changes"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
