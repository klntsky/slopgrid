import { createContext, useContext, useId, type ReactNode } from "react";
import type { ZodIssue } from "zod";
import { ErrorMessage } from "../components/feedback-message";

type ValidationIssue = Pick<ZodIssue, "message" | "path">;

type Path = readonly (string | number)[];
const ValidationContext = createContext<{
  issues: readonly ValidationIssue[];
  path: Path;
}>({ issues: [], path: [] });

export function ValidationProvider({
  issues,
  children,
}: {
  issues: readonly ValidationIssue[];
  children: ReactNode;
}) {
  return (
    <ValidationContext.Provider value={{ issues, path: [] }}>
      {children}
    </ValidationContext.Provider>
  );
}

export function ValidationScope({
  path,
  children,
}: {
  path: Path;
  children: ReactNode;
}) {
  const parent = useContext(ValidationContext);
  return (
    <ValidationContext.Provider
      value={{ issues: parent.issues, path: [...parent.path, ...path] }}
    >
      {children}
    </ValidationContext.Provider>
  );
}

function useValidationMessages(path: Path, descendants: boolean) {
  const context = useContext(ValidationContext);
  const fullPath = [...context.path, ...path];
  return [
    ...new Set(
      context.issues
        .filter(
          (issue) =>
            (descendants || issue.path.length === fullPath.length) &&
            issue.path.length >= fullPath.length &&
            fullPath.every((part, index) => issue.path[index] === part),
        )
        .map((issue) => issue.message),
    ),
  ];
}

function Feedback({ messages, id }: { messages: string[]; id?: string }) {
  return <ErrorMessage id={id}>{messages.join(" ")}</ErrorMessage>;
}

export function ValidationFeedback({
  path = [],
  descendants = false,
}: {
  path?: Path;
  descendants?: boolean;
}) {
  return <Feedback messages={useValidationMessages(path, descendants)} />;
}

export type ValidationAttributes = {
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
};

export function ValidationField({
  path = [],
  descendants = true,
  children,
}: {
  path?: Path;
  descendants?: boolean;
  children: (attributes: ValidationAttributes) => ReactNode;
}) {
  const id = useId();
  const messages = useValidationMessages(path, descendants);
  return (
    <>
      {children({
        "aria-invalid": messages.length ? true : undefined,
        "aria-describedby": messages.length ? id : undefined,
      })}
      <Feedback messages={messages} id={id} />
    </>
  );
}
