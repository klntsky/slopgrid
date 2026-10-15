import { useState } from "react";
import { useOffline } from "./pwa";

export function ContainedImage({
  src,
  alt,
  loading,
}: {
  src: string | undefined;
  alt: string;
  loading?: "lazy";
}) {
  const offline = useOffline();
  const [failed, setFailed] = useState<string>();
  return (
    <div className="image-preview">
      {offline && failed === src ? (
        <div>
          <p>This output isn't available offline.</p>
          <button className="secondary" onClick={() => setFailed(undefined)}>
            Retry
          </button>
        </div>
      ) : (
        <img
          className="generated-image"
          src={src}
          alt={alt}
          loading={loading}
          onError={() => setFailed(src)}
        />
      )}
    </div>
  );
}
