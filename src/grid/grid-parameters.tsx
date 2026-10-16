import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import tippy, { type Instance } from "tippy.js";
import { SlidersHorizontal, X } from "lucide-react";
import type { ViewGrid } from "../api";
import type { ReferenceImage } from "../../server/image-settings";
import { dimensionNames } from "../format";
import { ModelName } from "../model-name";
import "./grid-parameters.css";

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

export function GridParameters({ grid }: { grid: ViewGrid }) {
  const { input } = grid;
  const axes = [input.rows.kind, input.columns.kind];
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
        className="secondary inference-toggle"
        aria-label="Parameters"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <SlidersHorizontal aria-hidden="true" />
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
              {!axes.includes("model") && (
                <div>
                  <dt>Model</dt>
                  <dd>
                    <ModelName model={input.model} />
                  </dd>
                </div>
              )}
              {(["size", "aspect_ratio", "quality", "background"] as const)
                .filter((kind) => !axes.includes(kind))
                .map((kind) => (
                  <div key={kind}>
                    <dt>{dimensionNames[kind]}</dt>
                    <dd>
                      {!input.imageSettings?.[kind] ||
                      input.imageSettings[kind] === "auto"
                        ? "Auto"
                        : input.imageSettings[kind]}
                    </dd>
                  </div>
                ))}
              {!axes.includes("input_references") && (
                <div>
                  <dt>Input references</dt>
                  <dd>
                    <References images={input.inputReferences ?? []} />
                  </dd>
                </div>
              )}
            </dl>
          </section>,
          container,
        )}
    </>
  );
}
