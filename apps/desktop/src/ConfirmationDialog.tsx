import { useEffect, useId, useRef } from "react";

export function ConfirmationDialog({
  message,
  decide,
}: {
  message: string;
  decide: (approved: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        event.preventDefault();
        decide(false);
      }}
    >
      <h2 id={titleId}>Confirm action</h2>
      <p id={messageId}>{message}</p>
      <div className="toolbar">
        <button onClick={() => decide(false)}>Cancel</button>
        <button className="primary" onClick={() => decide(true)}>
          Confirm
        </button>
      </div>
    </dialog>
  );
}
