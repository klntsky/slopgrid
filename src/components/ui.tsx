import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Copy, Check, X, LoaderCircle, TriangleAlert } from "lucide-react";

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
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [focusable, setFocusable] = useState(false);
  useLayoutEffect(() => {
    setFocusable(
      !!text &&
        !anchor.current?.querySelector(
          "button, a, input, select, textarea, [tabindex]",
        ),
    );
  }, [children, text]);
  useLayoutEffect(() => {
    if (!show || !text) return;
    const place = () => {
      const tip = tooltip.current!,
        target = anchor.current!;
      const a = target.getBoundingClientRect(),
        t = tip.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(innerWidth - t.width - 8, a.left + (a.width - t.width) / 2),
      );
      const top = Math.max(
        8,
        Math.min(
          innerHeight - t.height - 8,
          a.top >= t.height + 16 ? a.top - t.height - 8 : a.bottom + 8,
        ),
      );
      Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(tooltip.current!);
    observer.observe(anchor.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [show, text]);
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
      ref={anchor}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={show && text ? id : undefined}
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
      {text &&
        show &&
        createPortal(
          <span
            ref={tooltip}
            id={id}
            className="tooltip"
            role="tooltip"
            data-theme={theme}
            data-state="visible"
          >
            {text}
          </span>,
          anchor.current?.closest("dialog") ?? document.body,
        )}
    </span>
  );
}
export function IconButton({
  label,
  children,
  tooltip = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tooltip?: boolean;
}) {
  const button = (
    <button type="button" className="icon-button" aria-label={label} {...props}>
      {children}
    </button>
  );
  return tooltip ? <Hint text={label}>{button}</Hint> : button;
}
export function CopyButton({
  value,
  label = "Copy output",
  load,
  copy,
  children,
}: {
  value: string;
  label?: string;
  load?: () => Promise<string>;
  copy?: () => Promise<void>;
  children?: ReactNode;
}) {
  const [state, setState] = useState<
    "idle" | "pending" | "success" | "failure"
  >("idle");
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const feedback = {
    idle: "",
    pending: "Copying",
    success: "Copied",
    failure: "Copy failed",
  }[state];
  return (
    <Hint
      text={(state !== "pending" && feedback) || (children ? undefined : label)}
    >
      <button
        type="button"
        className={children ? undefined : "icon-button"}
        aria-label={label}
        disabled={state === "pending"}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          clearTimeout(timer.current);
          setState("pending");
          try {
            if (copy) await copy();
            else
              await navigator.clipboard.writeText(load ? await load() : value);
            setState("success");
          } catch {
            setState("failure");
          } finally {
            pending.current = false;
            timer.current = setTimeout(() => setState("idle"), 2500);
          }
        }}
      >
        {children}
        {state === "pending" ? (
          <LoaderCircle className="spinner" />
        ) : state === "success" ? (
          <Check />
        ) : state === "failure" ? (
          <TriangleAlert />
        ) : (
          <Copy />
        )}
      </button>
      <span role="status" className="sr-only">
        {feedback}
      </span>
    </Hint>
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
  closeButton = true,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
  closeButton?: boolean;
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
        {closeButton && (
          <IconButton label="Close" disabled={busy} onClick={close}>
            <X />
          </IconButton>
        )}
      </header>
      {children}
    </dialog>,
    document.body,
  );
}
