import { useEffect, useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";

export function ModelName({ model }: { model: string }) {
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 2000);
    return () => clearTimeout(timer);
  }, [feedback]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(model);
      setFeedback("Model ID copied");
    } catch {
      setFeedback("Copy failed. Select the model ID and copy it manually.");
    }
  }
  return (
    <span className="model-name">
      <button
        type="button"
        className="model-copy"
        aria-label={`Copy model ID ${model}`}
        title={feedback || `Copy ${model}`}
        onClick={copy}
      >
        <span>{model}</span>
        {feedback === "Model ID copied" ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </button>
      <a
        className="model-link"
        href={`https://openrouter.ai/${model.split("/").map(encodeURIComponent).join("/")}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${model} on OpenRouter`}
        title="View model on OpenRouter"
      >
        <Link2 aria-hidden="true" />
      </a>
      <span role="status" className="sr-only">
        {feedback}
      </span>
    </span>
  );
}
