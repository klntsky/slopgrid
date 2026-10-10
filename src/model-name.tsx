import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

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
      <span role="status" className="sr-only">
        {feedback}
      </span>
    </span>
  );
}
