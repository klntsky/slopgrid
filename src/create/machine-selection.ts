import { fstarCreationMachine } from "./fstar-machine";
import { typescriptCreationMachine } from "./model";

const preferenceKey = "slopgrid-creation-machine";

function implementationForPage(): "fstar" | "typescript" {
  if (typeof window === "undefined" || !window.location) return "fstar";
  const requested = new URLSearchParams(window.location.search).get(
    "creationMachine",
  );
  if (requested === "fstar" || requested === "typescript") {
    sessionStorage.setItem(preferenceKey, requested);
    return requested;
  }
  return sessionStorage.getItem(preferenceKey) === "typescript"
    ? "typescript"
    : "fstar";
}

// Resolve on page load, before homepage links can discard the query parameter.
// Changing the URL and reloading starts a new machine; active handles never move
// between implementations. Canonical draft persistence is shared by both.
export const creationMachineImplementation = implementationForPage();
export const selectedCreationMachine =
  creationMachineImplementation === "typescript"
    ? typescriptCreationMachine
    : fstarCreationMachine;
