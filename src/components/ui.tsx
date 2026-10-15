import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Copy, Check, X } from "lucide-react";

export function Hint({
  text,
  children,
  theme,
  attribute,
  overflowOnly,
}: {
  text?: string;
  children: ReactNode;
  theme?: string;
  attribute?: boolean;
  overflowOnly?: boolean;
}) {
  const [show, setShow] = useState(false);
  const owner = useRef({});
  useEffect(() => {
    const hide = (e: Event) => {
      if ((e as CustomEvent).detail !== owner.current) setShow(false);
    };
    window.addEventListener("tooltip", hide);
    return () => window.removeEventListener("tooltip", hide);
  }, []);
  const reveal = (e: React.SyntheticEvent<HTMLSpanElement>) => {
    const child = e.currentTarget.firstElementChild as HTMLElement | null;
    if (overflowOnly && child && child.scrollWidth <= child.clientWidth) return;
    window.dispatchEvent(new CustomEvent("tooltip", { detail: owner.current }));
    setShow(true);
  };
  return (
    <span
      className="hint"
      data-tooltip={attribute ? text : undefined}
      onMouseEnter={reveal}
      onMouseLeave={() => setShow(false)}
      onFocus={reveal}
      onBlur={() => setShow(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setShow(false);
      }}
    >
      {children}
      {text && show && (
        <span role="tooltip" data-theme={theme} data-state="visible">
          {text}
        </span>
      )}
    </span>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Hint text={label}>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        {...props}
      >
        {children}
      </button>
    </Hint>
  );
}
export function CopyButton({
  value,
  label = "Copy output",
  load,
  copy,
}: {
  value: string;
  label?: string;
  load?: () => Promise<string>;
  copy?: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : label}
      onClick={async () => {
        if (copy) await copy();
        else await navigator.clipboard.writeText(load ? await load() : value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  );
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p role="alert">{error instanceof Error ? error.message : String(error)}</p>
  ) : null;
}
export function Modal({
  title,
  close,
  children,
  busy = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    ref.current
      ?.querySelector<HTMLElement>(
        "input:checked, input:not([type=checkbox],[type=radio]), button:not([aria-label=Close])",
      )
      ?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton label="Close" disabled={busy} onClick={close}>
          <X />
        </IconButton>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
