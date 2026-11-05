import type {
  CreationMachine,
  WireCreationMachine,
} from "./machine-contract.js";
import {
  creationInitialCodec,
  creationContextCodec,
  creationEventCodec,
  creationOutputCodec,
  creationViewCodec,
} from "./machine-codec.js";

export function toWireCreationMachine<State>(
  machine: CreationMachine<State>,
): WireCreationMachine<unknown> {
  const handles = new WeakMap<object, State>();
  function wrap(state: State): object {
    const handle = Object.freeze({});
    handles.set(handle, state);
    return handle;
  }
  function unwrap(handle: unknown): State {
    if (typeof handle !== "object" || handle === null || !handles.has(handle))
      throw new TypeError("Unknown creation machine handle.");
    return handles.get(handle)!;
  }
  return {
    init(initial, context) {
      return wrap(
        machine.init(
          creationInitialCodec.decode(initial),
          creationContextCodec.decode(context),
        ),
      );
    },
    update(handle, event) {
      const transition = machine.update(
        unwrap(handle),
        creationEventCodec.decode(event),
      );
      const output = creationOutputCodec.encode({
        outcome: transition.outcome,
        commands: transition.commands,
      });
      return { state: wrap(transition.state), output };
    },
    view(handle) {
      return creationViewCodec.encode(machine.view(unwrap(handle)));
    },
  };
}

export function fromWireCreationMachine<State>(
  backend: WireCreationMachine<State>,
): CreationMachine<State> {
  return {
    init(initial, context) {
      return backend.init(
        creationInitialCodec.encode(initial),
        creationContextCodec.encode(context),
      );
    },
    update(state, event) {
      const transition = backend.update(
        state,
        creationEventCodec.encode(event),
      );
      const output = creationOutputCodec.decode(transition.output);
      return { state: transition.state, ...output };
    },
    view(state) {
      return creationViewCodec.decode(backend.view(state));
    },
  };
}
