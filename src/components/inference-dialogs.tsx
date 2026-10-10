import { useRef, useEffect } from "react";
import { formatCost } from "../format";
import { ErrorMessage } from "./error-message";
export function LowBalanceDialog({
  balanceUsd,
  busy,
  error,
  onProceed,
  onClose,
}: {
  balanceUsd: number;
  busy: boolean;
  error: string;
  onProceed: (override: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="low-balance-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="low-balance-title">Top up your OpenRouter credits</h2>
      <p>
        Your balance is {formatCost(balanceUsd)}, below $3. Top up before
        starting inference, or continue with one generation at a time across
        your grids.
      </p>
      <div className="modal-actions">
        <a
          className="button primary"
          href="https://openrouter.ai/settings/credits"
          target="_blank"
          rel="noopener noreferrer"
        >
          Top up
        </a>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => onProceed(false)}
        >
          Check balance again
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => onProceed(true)}
        >
          Continue anyway
        </button>
        <button
          className="text-button"
          disabled={busy}
          autoFocus
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
      <ErrorMessage error={error} />
    </dialog>
  );
}
export function BillingDialog({
  busy,
  error,
  onRetry,
  onClose,
}: {
  busy: boolean;
  error: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="billing-title"
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="billing-title">OpenRouter credits needed</h2>
      <p>
        OpenRouter could not bill this request. Check your credits or key
        spending limit, then retry. Completed cells are saved.
      </p>
      <div className="modal-actions">
        <a
          className="button primary"
          href="https://openrouter.ai/settings/credits"
          target="_blank"
          rel="noreferrer"
        >
          Add credits
        </a>
        <button className="secondary" disabled={busy} onClick={onRetry}>
          Retry unfinished cells
        </button>
        <button className="text-button" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
      <ErrorMessage error={error} />
    </dialog>
  );
}
