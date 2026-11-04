import { wireCreationMachine } from "./fstar/creation-machine.generated.js";
import { fromWireCreationMachine } from "./machine-wire";

export const fstarCreationMachine =
  fromWireCreationMachine(wireCreationMachine);
