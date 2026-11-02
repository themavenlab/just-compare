import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

export function WorkspaceDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = element.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={element}
      className="workspace-dialog"
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
