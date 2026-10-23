import type { ComponentPropsWithoutRef } from "react";

type MessageProps = Omit<ComponentPropsWithoutRef<"div">, "role">;

function FeedbackMessage({
  tone,
  children,
  className,
  ...attributes
}: MessageProps & { tone: "error" | "warning" }) {
  if (children == null || children === false || children === "") return null;
  return (
    <div
      {...attributes}
      role={tone === "error" ? "alert" : "status"}
      className={`feedback-message${className ? ` ${className}` : ""}`}
      data-tone={tone}
    >
      <span className="feedback-icon" aria-hidden="true">
        {tone === "error" ? "❗" : "⚠️"}
      </span>
      <div className="feedback-content">{children}</div>
    </div>
  );
}

export function ErrorMessage(props: MessageProps) {
  return <FeedbackMessage {...props} tone="error" />;
}

export function WarningMessage(props: MessageProps) {
  return <FeedbackMessage {...props} tone="warning" />;
}
