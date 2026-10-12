import { tooltipRef } from "./components/use-tooltip";
import { Link } from "lucide-react";
import { CopyButton } from "./components/copy-button";

export function ModelName({ model }: { model: string }) {
  return (
    <span className="model-name">
      <CopyButton
        className="model-copy"
        label={`Copy model ID ${model}`}
        title=""
        copy={() => navigator.clipboard.writeText(model)}
        success="Model ID copied"
        failure="Copy failed. Select the model ID and copy it manually."
      >
        <span>{model}</span>
      </CopyButton>
      <a
        className="model-link"
        href={`https://openrouter.ai/${model.split("/").map(encodeURIComponent).join("/")}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${model} on OpenRouter`}
        data-tooltip="View model on OpenRouter"
        ref={tooltipRef}
      >
        <Link aria-hidden="true" />
      </a>
    </span>
  );
}
