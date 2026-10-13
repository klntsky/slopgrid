import { useState } from "react";
import { validImageSize } from "../../server/image-settings";
import { ErrorMessage } from "../components/error-message";

export function CustomImageSize({
  label,
  onSelect,
}: {
  label: string;
  onSelect: (size: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="custom-image-size">
      <input
        aria-label={label}
        placeholder="1536x1024"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError("");
        }}
      />
      <button
        type="button"
        className="secondary"
        onClick={() => {
          const size = value.trim();
          if (!validImageSize(size)) {
            setError("Use a resolution or a size such as 1536x1024.");
            return;
          }
          onSelect(size);
          setValue("");
          setError("");
        }}
      >
        Add size
      </button>
      <ErrorMessage error={error} />
    </div>
  );
}
