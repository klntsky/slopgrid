import type { UseMutationResult } from "@tanstack/react-query";
import type { ViewGrid } from "../api";
import { Modal } from "./modal";
import { useEffect, useRef, useState } from "react";
import type { GridVisibility } from "../../server/domain";
import { ErrorMessage } from "./error-message";
import { isGridSlug, slugNamingError } from "../../shared/grid-slug";

export type Publication = { visibility: GridVisibility; slug?: string };

const confirmationPreference = "slopgrid-skip-publish-confirmation";
function skipConfirmation() {
  try {
    return localStorage.getItem(confirmationPreference) === "true";
  } catch {
    return false;
  }
}

export function PublishDialog({
  initialVisibility,
  initialSlug,
  publish,
  onClose,
}: {
  initialVisibility: GridVisibility;
  initialSlug?: string;
  publish: UseMutationResult<ViewGrid, Error, Publication>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [slug, setSlug] = useState(initialSlug ?? "");
  const [validation, setValidation] = useState("");
  const published = initialVisibility !== "private";
  const [confirming, setConfirming] = useState(false);
  const [remember, setRemember] = useState(false);
  const { isPending: busy, error, reset } = publish;
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>(
        confirming ? "[data-confirm]" : "input:checked",
      )
      ?.focus();
  }, [confirming]);

  async function save() {
    try {
      await publish.mutateAsync({
        visibility,
        ...(visibility === "public" ? { slug } : {}),
      });
      if (confirming && remember) {
        try {
          localStorage.setItem(confirmationPreference, "true");
        } catch {
          /* Ask again when storage is unavailable. */
        }
      }
      onClose();
    } catch {
      // The mutation supplies the error displayed below.
    }
  }
  function cancel() {
    if (busy) return;
    reset();
    if (confirming) setConfirming(false);
    else onClose();
  }
  return (
    <Modal
      ref={ref}
      className="publish-modal"
      titleId="publish-title"
      busy={busy}
      onClose={cancel}
    >
      <h2 id="publish-title">
        {confirming
          ? "Confirm publishing"
          : initialVisibility === "public"
            ? "Claim slug"
            : "Control who can see this grid"}
      </h2>
      {confirming ? (
        <>
          <p>
            This project aims to facilitate model benchmarking and research, and
            we don't want valuable data to disappear. For this reason, making a
            published grid private is impossible.
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
          )
            .filter(([value]) =>
              initialVisibility === "public"
                ? value === "public"
                : !published || value !== "private",
            )
            .map(([value, label]) => (
              <label className="publish-choice" key={value}>
                <input
                  type="radio"
                  name="grid-visibility"
                  value={value}
                  checked={visibility === value}
                  onChange={() => {
                    setVisibility(value);
                    setValidation("");
                    reset();
                  }}
                />
                {label}
              </label>
            ))}
        </fieldset>
      )}
      {!confirming && visibility === "public" && (
        <label>
          Slug (optional)
          <input
            type="text"
            value={slug}
            disabled={busy || !!initialSlug}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setSlug(event.target.value);
              setValidation("");
              reset();
            }}
          />
        </label>
      )}
      <div className="modal-actions">
        <button
          className="primary"
          data-confirm
          disabled={busy}
          onClick={() => {
            if (visibility === "public" && slug && !isGridSlug(slug)) {
              setValidation(slugNamingError);
              return;
            }
            if (visibility === "private") onClose();
            else if (published || confirming || skipConfirmation()) void save();
            else setConfirming(true);
          }}
        >
          {confirming ? "Confirm" : "Save"}
        </button>
        <button className="text-button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      <ErrorMessage error={validation || error?.message} />
    </Modal>
  );
}
