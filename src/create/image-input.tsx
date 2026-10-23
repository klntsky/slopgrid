import { useEffect, useRef, useState } from "react";
import { readReferenceFile, saveReferenceFile } from "./reference-files";
import { Paperclip, X } from "lucide-react";
import type { ReferenceImage } from "../../server/image-settings";
import { ErrorMessage } from "../components/feedback-message";
import { tooltipRef } from "../components/use-tooltip";

export function ImagePicker({
  accessibleLabel = "Add images",
  disabled = false,
  pasteTarget,
  onSelect,
  onBusy,
}: {
  accessibleLabel?: string;
  disabled?: boolean;
  pasteTarget?: string;
  onSelect: (images: ReferenceImage[]) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  const reading = useRef(false);
  const selected = useRef(onSelect);
  selected.current = onSelect;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function select(files: FileList | File[] | null) {
    if (!files?.length || reading.current || disabled) return;
    reading.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const images = await Promise.all(Array.from(files, saveReferenceFile));
      if (mounted.current) selected.current(images);
    } catch {
      if (mounted.current)
        setError("Could not keep these files in browser storage.");
    } finally {
      reading.current = false;
      if (mounted.current) setBusy(false);
      onBusy(false);
    }
  }
  const intake = useRef(select);
  intake.current = select;
  useEffect(() => {
    if (!pasteTarget) return;
    const target = document.getElementById(pasteTarget);
    if (!target) return;
    const paste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter(
        (file) => file.type.startsWith("image/"),
      );
      if (!images.length) return;
      event.preventDefault();
      void intake.current(images);
    };
    target.addEventListener("paste", paste);
    return () => target.removeEventListener("paste", paste);
  }, [pasteTarget]);
  return (
    <>
      <label
        className="button text-button editor-icon-button reference-upload reference-upload-compact"
        ref={tooltipRef}
        data-tooltip={accessibleLabel}
      >
        <Paperclip aria-hidden="true" />
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          aria-label={accessibleLabel}
          disabled={disabled || busy}
          onChange={(event) => {
            void select(event.target.files);
            event.target.value = "";
          }}
        />
      </label>
      {busy && <span role="status">Reading images...</span>}
      <ErrorMessage>{error}</ErrorMessage>
    </>
  );
}

export function ImageList({
  images,
  disabled = false,
  removeLabel,
  onRemove,
}: {
  images: readonly ReferenceImage[];
  disabled?: boolean;
  removeLabel: (image: ReferenceImage) => string;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="reference-images">
      {images.map((image, index) => (
        <div className="reference-image" key={`${image.id}-${index}`}>
          <ImagePreview image={image} />
          <button
            type="button"
            className="text-button editor-icon-button editor-icon-danger"
            disabled={disabled}
            aria-label={removeLabel(image)}
            ref={tooltipRef}
            data-tooltip={removeLabel(image)}
            onClick={() => onRemove(index)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ImagePreview({ image }: { image: ReferenceImage }) {
  const [url, setURL] = useState<string>();
  useEffect(() => {
    if (!image.id.startsWith("local-")) return;
    let active = true,
      objectURL: string | undefined;
    void readReferenceFile(image.id)
      .then((file) => {
        if (active && file) {
          objectURL = URL.createObjectURL(file);
          setURL(objectURL);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [image.id]);
  return (
    <img
      src={image.id.startsWith("local-") ? url : `/api/references/${image.id}`}
      alt={image.name}
    />
  );
}
