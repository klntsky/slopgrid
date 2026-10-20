import { useState } from "react";
import type { ReferenceImage } from "../../server/image-settings";
import { ReferenceImageList, ReferencePicker } from "./reference-groups";

export function PromptEditor({
  prompt,
  images,
  onPromptChange,
  onImagesChange,
  onBusy,
}: {
  prompt: string;
  images: readonly ReferenceImage[];
  onPromptChange: (prompt: string) => void;
  onImagesChange: (
    change: (images: readonly ReferenceImage[]) => ReferenceImage[],
  ) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [reading, setReading] = useState(false);
  return (
    <div className="prompt-editor" aria-busy={reading}>
      <div className="prompt-input">
        <textarea
          id="grid-prompt"
          aria-label="Prompt"
          rows={6}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="Describe what you want to generate"
        />
        <ReferencePicker
          compact
          pasteTarget="grid-prompt"
          accessibleLabel="Add images to prompt"
          disabled={reading}
          onBusy={(busy) => {
            setReading(busy);
            onBusy(busy);
          }}
          onSelect={(selected) =>
            onImagesChange((current) => [...current, ...selected])
          }
        />
      </div>
      {!!images.length && (
        <ReferenceImageList
          images={images}
          disabled={reading}
          removeLabel={(image) => `Remove ${image.name} from prompt`}
          onRemove={(index) =>
            onImagesChange((current) => current.filter((_, i) => i !== index))
          }
        />
      )}
    </div>
  );
}
