import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import tippy, { type Instance } from "tippy.js";
import { Info, X } from "lucide-react";
import type { ViewGrid } from "../api";
import type { ReferenceImage } from "../../server/image-settings";
import { dimensionNames, displayValue } from "../format";
import { ModelName } from "../model-name";
import "./grid-parameters.css";
import {
  gridDisplay,
  type ParameterDisplayPart,
} from "../../shared/grid-display";

function References({ images }: { images: ReferenceImage[] }) {
  return images.length ? (
    <span className="parameter-references">
      {images.map((image, index) => (
        <a
          key={`${image.id}-${index}`}
          href={`/api/references/${image.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            src={`/api/references/${image.id}`}
            alt={image.name}
            loading="lazy"
          />
          <span>{image.name}</span>
        </a>
      ))}
    </span>
  ) : (
    "None"
  );
}

function ParameterValue({ part }: { part: ParameterDisplayPart }) {
  if (part.kind === "model" || part.kind === "judge_model")
    return <ModelName model={part.value} />;
  if (part.kind === "images")
    return (
      <>
        {part.value.name && <span>{part.value.name}</span>}
        <References images={part.value.images} />
      </>
    );
  if (part.kind === "judge_criteria")
    return (
      <ol>
        {part.value.map((criterion, index) => (
          <li key={index}>
            {criterion.text} (expected {criterion.correctAnswer ? "YES" : "NO"})
          </li>
        ))}
      </ol>
    );
  return displayValue(part);
}

export function GridParameters({ grid }: { grid: ViewGrid }) {
  const display = grid.display ?? gridDisplay(grid.input);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<Instance | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  useEffect(() => {
    const element = button.current!;
    const content = document.createElement("div");
    setContainer(content);
    const instance = tippy(element, {
      content,
      theme: "grid-parameters",
      trigger: "click",
      interactive: true,
      placement: "bottom-end",
      maxWidth: "min(900px, calc(100vw - 24px))",
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
    // Grid panning prevents mousedown, so dismiss before its pointer handler.
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
        className="text-button prompt-copy parameters-info"
        aria-label="Parameters"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Info aria-hidden="true" />
      </button>
      {container &&
        createPortal(
          <section
            id={panelId}
            className="grid-parameters"
            role="dialog"
            aria-label="Parameters"
            tabIndex={-1}
          >
            <div className="parameter-heading">
              <h2>Parameters</h2>
              <button
                type="button"
                className="text-button"
                aria-label="Close parameters"
                onClick={() => {
                  popup.current?.hide();
                  button.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <dl>
              {display.common.map((part) => (
                <div key={part.kind}>
                  <dt>{dimensionNames[part.kind]}</dt>
                  <dd>
                    <ParameterValue part={part} />
                  </dd>
                </div>
              ))}
            </dl>
            {!!display.promptImages.length && (
              <section aria-label="Prompt images">
                <h3>Prompt images</h3>
                <References images={display.promptImages} />
              </section>
            )}
          </section>,
          container,
        )}
    </>
  );
}
