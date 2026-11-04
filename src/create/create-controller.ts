import type {
  CreateCommand,
  CreateContext,
  CreateEvent,
  CreateInitial,
  CreateOutcome,
  CreateView,
  CreationMachine,
} from "./machine-contract";
import { typescriptCreationMachine } from "./model";

export type CreationEffects = {
  publish?(view: CreateView): void;
  execute(command: CreateCommand): void;
};

export function createCreationController(
  initial: CreateInitial,
  context: CreateContext,
  machine: CreationMachine<unknown> = typescriptCreationMachine,
) {
  let state = machine.init(initial, context);
  const dispatches: CreateOutcome[] = [];
  return {
    view: () => machine.view(state),
    dispatch(event: CreateEvent, effects: CreationEffects): CreateOutcome {
      const outcome = { stateChanged: false, draftChanged: false };
      dispatches.push(outcome);
      try {
        const transition = machine.update(state, event);
        state = transition.state;
        for (const active of dispatches) {
          active.stateChanged ||= transition.outcome.stateChanged;
          active.draftChanged ||= transition.outcome.draftChanged;
        }
        if (transition.outcome.stateChanged && effects.publish)
          effects.publish(machine.view(state));
        for (const command of transition.commands) effects.execute(command);
        return outcome;
      } finally {
        dispatches.pop();
      }
    },
  };
}
