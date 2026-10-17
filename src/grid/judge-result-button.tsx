import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import tippy, { type Instance } from "tippy.js";
import { Check, Scale, X } from "lucide-react";
import type { GridInput } from "../../server/domain";
import type { ViewGrid } from "../api";
import "./judge-result-button.css";

export function JudgeResultButton({
  judge,
  criteria,
  gridStatus,
}: {
  judge: NonNullable<ViewGrid["cells"][number]["judge"]>;
  criteria: NonNullable<GridInput["judge"]>["criteria"];
  gridStatus: ViewGrid["status"];
}) {
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<Instance | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const results =
    judge.status === "complete" &&
    judge.results?.length === criteria.length &&
    judge.results.every(
      (result) =>
        typeof result.verdict === "boolean" &&
        typeof result.explanation === "string" &&
        result.explanation.trim().length > 0,
    )
      ? judge.results
      : undefined;
  const correct = results?.reduce(
    (count, result, index) =>
      count + Number(result.verdict === criteria[index].correctAnswer),
    0,
  );
  const state =
    judge.status === "error"
      ? `Judging failed: ${judge.error ?? "The judge returned an invalid structured result."}`
      : judge.status === "complete" && !results
        ? "Judging failed: The judge returned an invalid structured result."
        : gridStatus === "paused"
          ? "Judge paused"
          : judge.retrying
            ? "Waiting to retry judging..."
            : judge.status === "running"
              ? "Judging..."
              : "Judge queued";
  const label = results
    ? `Judgment: ${correct} of ${criteria.length} correct`
    : state;

  useEffect(() => {
    const element = button.current!;
    const content = document.createElement("div");
    setContainer(content);
    const instance = tippy(element, {
      content,
      theme: "judge-result",
      trigger: "click",
      interactive: true,
      placement: "bottom-end",
      maxWidth: "min(420px, calc(100vw - 24px))",
      appendTo: () => document.body,
      arrow: false,
      role: "presentation",
      aria: { content: null, expanded: false },
      onShow: () => setOpen(true),
      onHide: () => setOpen(false),
      onMount: () =>
        content.querySelector<HTMLElement>("[role=dialog]")?.focus(),
    });
    popup.current = instance;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !instance.state.isVisible) return;
      event.preventDefault();
      event.stopPropagation();
      instance.hide();
      element.focus();
    };
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        event.target !== element &&
        !content.contains(event.target)
      )
        instance.hide();
    };
    // Dismiss before grid panning prevents the pointer's default behavior.
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !instance.popper.contains(event.target)
      )
        instance.hide();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", outside, true);
      instance.destroy();
      popup.current = null;
    };
  }, []);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="judge-result-button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Scale aria-hidden="true" />
        <span aria-hidden="true">
          {correct ?? "-"}/{criteria.length}
        </span>
      </button>
      {container &&
        createPortal(
          <section
            id={panelId}
            className="judge-result-popup"
            role="dialog"
            aria-label="Judged output"
            tabIndex={-1}
          >
            <div className="judge-result-heading">
              <h2>Judged output</h2>
              <button
                type="button"
                className="text-button"
                aria-label="Close judgment"
                onClick={() => {
                  popup.current?.hide();
                  button.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {!results && (
              <p className="judge-result-state" role="status">
                {state}
              </p>
            )}
            <ol className="judge-result-criteria">
              {criteria.map((criterion, index) => {
                const result = results?.[index];
                const matches = result?.verdict === criterion.correctAnswer;
                return (
                  <li key={index}>
                    <div
                      className={`judge-result-criterion${result ? (matches ? " judge-correct" : " judge-incorrect") : ""}`}
                    >
                      {criterion.text}
                    </div>
                    {result ? (
                      <>
                        <div
                          className={`judge-result-verdict ${matches ? "judge-correct" : "judge-incorrect"}`}
                        >
                          {matches ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <X aria-hidden="true" />
                          )}
                          {matches ? "Correct" : "Incorrect"}
                        </div>
                        <p className="judge-result-explanation">
                          {result.explanation}
                        </p>
                      </>
                    ) : (
                      <span
                        className="judge-result-unresolved"
                        aria-label={state}
                      >
                        -
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>,
          container,
        )}
    </>
  );
}
