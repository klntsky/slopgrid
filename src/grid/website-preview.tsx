import { LoaderCircle } from "lucide-react";
import "./website-preview.css";

export function WebsitePreview({
  url,
  title,
}: {
  url?: string;
  title: string;
}) {
  if (!url)
    return (
      <div className="pending" role="status">
        <LoaderCircle className="spinner" aria-hidden="true" />
        Generating…
      </div>
    );
  return (
    <>
      <iframe
        aria-label={title}
        sandbox="allow-scripts"
        src={url}
        loading="lazy"
      />
      <span className="website-preview-status" role="status">
        <LoaderCircle className="spinner" aria-hidden="true" />
        Generating…
      </span>
    </>
  );
}
