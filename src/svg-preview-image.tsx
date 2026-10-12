import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { completeSvgPreview } from "./svg-preview";
import { ContainedImage } from "./contained-image";

export function SvgPreview({ draft }: { draft: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    const svg = completeSvgPreview(draft);
    if (!svg) return;
    let next: string;
    try {
      next = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      // A chunk can end between the two halves of a Unicode surrogate pair.
      return;
    }
    const candidate = new window.Image();
    candidate.onload = () => setSource(next);
    candidate.src = next;
    return () => {
      // A slow, superseded image must not overwrite a newer preview.
      candidate.onload = null;
    };
  }, [draft]);
  return source ? (
    <>
      <ContainedImage alt="SVG preview" src={source} />
      <div className="cell-footer preview-status" role="status">
        <LoaderCircle className="spinner" aria-hidden="true" />
        Generating…
      </div>
    </>
  ) : (
    <div className="pending" role="status">
      <LoaderCircle className="spinner" aria-hidden="true" />
      Generating…
    </div>
  );
}
