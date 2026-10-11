import { useEffect, useRef, useState } from "react";
import type { GridVisibility } from "../../server/domain";
import { ErrorMessage } from "./error-message";

const confirmationPreference = "slopgrid-skip-publish-confirmation";
function skipConfirmation() {
  try {
    return localStorage.getItem(confirmationPreference) === "true";
  } catch {
    return false;
  }
}

export function PublishDialog({
  busy,
  onPublish,
  onClose,
}: {
  busy: boolean;
  onPublish: (visibility: GridVisibility) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [visibility, setVisibility] = useState<GridVisibility>("private");
  const [confirming, setConfirming] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>(
        confirming ? "[data-confirm]" : "input:checked",
      )
      ?.focus();
  }, [confirming]);

  async function save() {
    setError("");
    try {
      await onPublish(visibility);
      if (confirming && remember) {
        try {
          localStorage.setItem(confirmationPreference, "true");
        } catch {
          /* Ask again when storage is unavailable. */
        }
      }
      onClose();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  function cancel() {
    if (busy) return;
    setError("");
    if (confirming) setConfirming(false);
    else onClose();
  }
  return (
    <dialog
      ref={ref}
      className="modal publish-modal"
      aria-labelledby="publish-title"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <h2 id="publish-title">
        {confirming ? "Confirm publishing" : "Control who can see this grid"}
      </h2>
      {confirming ? (
        <>
          <p>
            This projects aims to facilitate model benchmarking and research,
            and we don't want valuable data to disappear. For this reason,
            making a published grid private is impossible.
          </p>
          <label className="publish-choice">
            <input
              type="checkbox"
              checked={remember}
              disabled={busy}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Don’t ask again
          </label>
        </>
      ) : (
        <fieldset
          className="publish-choices"
          disabled={busy}
          aria-label="Grid visibility"
        >
          {(
            [
              ["private", "Keep private"],
              ["unlisted", "Accessible by link"],
              ["public", "Listed publicly"],
            ] as const
          ).map(([value, label]) => (
            <label className="publish-choice" key={value}>
              <input
                type="radio"
                name="grid-visibility"
                value={value}
                checked={visibility === value}
                onChange={() => {
                  setVisibility(value);
                  setError("");
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="modal-actions">
        <button
          className="primary"
          data-confirm
          disabled={busy}
          onClick={() => {
            if (visibility === "private") onClose();
            else if (confirming || skipConfirmation()) void save();
            else setConfirming(true);
          }}
        >
          {confirming ? "Confirm" : "Save"}
        </button>
        <button className="text-button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      <ErrorMessage error={error} />
    </dialog>
  );
}
