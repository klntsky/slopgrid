import { useEffect, useRef, useState } from "react";
import { readReferenceFile, saveReferenceFile } from "./reference-files";
import { Paperclip, Pencil, X } from "lucide-react";
import type {
  ReferenceGroups as Groups,
  ReferenceImage,
} from "../../server/image-settings";
import { EditableTitle } from "../components/editable-title";
import { ErrorMessage } from "../components/error-message";

export function ReferenceGroups({
  values,
  groups,
  onChange,
  onBusy,
  shared = false,
}: {
  shared?: boolean;
  values: string[];
  groups: Groups;
  onChange: (values: string[], groups?: Groups) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  function reading(busy: boolean) {
    setBusy(busy);
    onBusy(busy);
  }
  function picker(group?: string) {
    return (
      <ReferencePicker
        label={group ? "Add images" : "Add reference group"}
        accessibleLabel={
          shared
            ? "Add input references"
            : group
              ? `Add images to ${group}`
              : "Add reference group"
        }
        icon={!!group}
        disabled={busy}
        onBusy={reading}
        onSelect={(images) => {
          let index = 1;
          while (Object.hasOwn(groups, `Group ${index}`)) index++;
          const name = group ?? `Group ${index}`;
          onChange(group ? values : [...values, name], {
            [name]: [...(group ? groups[group] : []), ...images],
          });
        }}
      />
    );
  }
  return (
    <div className="reference-groups" aria-busy={busy}>
      {values.map((name, position) => (
        <div className="reference-group" key={position}>
          {!shared && (
            <div className="reference-heading">
              <div className="reference-title-line">
                <EditableTitle
                  key={name}
                  value={name}
                  label="Reference group title"
                  editLabel={`Edit reference group title: ${name}`}
                  disabled={busy}
                  icon={<Pencil aria-hidden="true" />}
                  onSave={(title) => {
                    if (!title)
                      throw new Error("Enter a reference group title.");
                    if (values.includes(title))
                      throw new Error("Use a different reference group title.");
                    onChange(
                      values.map((value) => (value === name ? title : value)),
                      { [title]: groups[name] },
                    );
                  }}
                />
                <span className="hint">· reference image group</span>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                aria-label={`Remove ${name}`}
                onClick={() =>
                  onChange(values.filter((value) => value !== name))
                }
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          <ReferenceImageList
            images={groups[name] ?? []}
            disabled={busy}
            removeLabel={(image) => `Remove ${image.name} from ${name}`}
            onRemove={(index) =>
              onChange(values, {
                [name]: groups[name].filter(
                  (_, position) => position !== index,
                ),
              })
            }
          />
          {picker(name)}
        </div>
      ))}
      {!shared && picker()}
    </div>
  );
}

export function ReferencePicker({
  label = "Add images",
  accessibleLabel = label,
  icon = true,
  disabled = false,
  onSelect,
  onBusy,
}: {
  label?: string;
  accessibleLabel?: string;
  icon?: boolean;
  disabled?: boolean;
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
  async function select(files: FileList | null) {
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
  return (
    <>
      <label className="button secondary reference-upload">
        {icon && <Paperclip aria-hidden="true" />}
        {label}
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
      <ErrorMessage error={error} />
    </>
  );
}

export function ReferenceImageList({
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
          <ReferencePreview image={image} />
          <span>{image.name}</span>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label={removeLabel(image)}
            onClick={() => onRemove(index)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ReferencePreview({ image }: { image: ReferenceImage }) {
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
