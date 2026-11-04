import type { CaseRecord, ParameterValues } from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";
import type {
  AxisSide,
  CommonParameterId,
  ParameterId,
} from "../../server/parameters";

export type MessageEdit =
  | { type: "content"; index: number; content: string }
  | { type: "insert"; index: number }
  | { type: "remove"; index: number }
  | { type: "move"; index: number; to: number }
  | { type: "cycle-role"; index: number; rememberedContent?: string }
  | { type: "append-images"; index: number; images: ReferenceImage[] }
  | { type: "remove-image"; index: number; imageIndex: number }
  | { type: "prompt-content"; content: string }
  | { type: "prompt-append-images"; images: ReferenceImage[] }
  | { type: "prompt-remove-image"; imageIndex: number };

type CommonAction = {
  [K in CommonParameterId]: {
    type: "common";
    parameter: K;
    value: ParameterValues[K];
  };
}[CommonParameterId];

export type CaseValueAction = {
  [K in ParameterId]: {
    type: "case-value";
    side: AxisSide;
    index: number;
    parameter: K;
    value: ParameterValues[K];
  };
}[ParameterId];

export type ScalarParameterId = Exclude<
  CommonParameterId,
  "input" | "judge_criteria" | "judge_system"
>;

export type CaseValuesAction = {
  [K in ScalarParameterId]: {
    type: "case-values";
    side: AxisSide;
    parameter: K;
    values: ParameterValues[K][];
  };
}[ScalarParameterId];

export type ParameterSetter = <K extends CommonParameterId>(
  parameter: K,
  value: ParameterValues[NoInfer<K>],
) => void;

export type InputAction =
  | CommonAction
  | CaseValueAction
  | CaseValuesAction
  | {
      type: "edit-input";
      source: "common";
      edit: MessageEdit;
    }
  | {
      type: "edit-input";
      source: AxisSide;
      caseIndex: number;
      edit: MessageEdit;
    }
  | { type: "to-axis"; parameter: CommonParameterId; side: AxisSide }
  | { type: "to-common"; parameter: CommonParameterId }
  | { type: "dimension"; side: AxisSide; parameter: ParameterId }
  | { type: "single"; side: AxisSide }
  | { type: "add-case"; side: AxisSide; value: CaseRecord }
  | { type: "remove-case"; side: AxisSide; index: number }
  | { type: "move-case"; side: AxisSide; index: number; to: number }
  | { type: "add-variable"; side: AxisSide }
  | { type: "remove-variable"; side: AxisSide; index: number }
  | { type: "rename-variable"; side: AxisSide; index: number; name: string }
  | { type: "rename-case"; side: AxisSide; index: number; name: string }
  | { type: "swap" }
  | { type: "judge"; enabled: boolean };
