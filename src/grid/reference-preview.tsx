import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minimize2 } from "lucide-react";
import type { ReferenceImage } from "../../server/image-settings";
import { IconButton } from "../components/ui";

export function ReferencePreview({ image }: { image: ReferenceImage }) {
  const [expanded, setExpanded] = useState(false),
    button = useRef<HTMLButtonElement>(null);
  function close() {
    setExpanded(false);
    requestAnimationFrame(() => button.current?.focus());
  }
  useEffect(() => {
    if (!expanded) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [expanded]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="reference-thumbnail"
        aria-label={`Expand reference image: ${image.name}`}
        onClick={() => setExpanded(true)}
      >
        <img
          src={`/api/references/${image.id}`}
          alt={image.name}
          width="32"
          height="32"
        />
      </button>
      {expanded &&
        createPortal(
          <section
            role="region"
            aria-label={`Expanded reference: ${image.name}`}
            className="cell-expanded reference-expanded"
          >
            <div className="cell-toolbar">
              <IconButton tooltip label="Collapse Image" onClick={close}>
                <Minimize2 />
              </IconButton>
            </div>
            <div className="image-preview">
              <img
                className="generated-image"
                src={`/api/references/${image.id}`}
                alt={image.name}
              />
            </div>
          </section>,
          document.body,
        )}
    </>
  );
}
