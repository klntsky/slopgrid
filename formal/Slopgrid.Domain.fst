module Slopgrid.Domain

module Number = Slopgrid.Number

type format =
  | Svg : format
  | Markdown : format
  | Html : format
  | ChatTemplate : format
  | Image : format

type axis =
  | Rows : axis
  | Columns : axis

type case_axes =
  | NoCaseAxes : case_axes
  | OneCaseAxis : axis -> case_axes
  | BothCaseAxes : first: axis -> case_axes

type effort =
  | DefaultEffort : effort
  | NoEffort : effort
  | MinimalEffort : effort
  | LowEffort : effort
  | MediumEffort : effort
  | HighEffort : effort
  | ExtraHighEffort : effort
  | MaxEffort : effort

type role =
  | SystemRole : role
  | UserRole : role
  | AssistantRole : role
  | UnfilledRole : role

type dimensions = {
  width: pos;
  height: pos
}

type reference_image = {
  reference_id: string;
  reference_name: string;
  reference_dimensions: option dimensions
}

type message = {
  message_role: role;
  content: string;
  images: option (list reference_image)
}

type variable_field = {
  text: string;
  field_images: option (list reference_image)
}

type criterion = {
  criterion_text: string;
  correct_answer: bool
}

type parameter =
  | PInput : parameter
  | PModel : parameter
  | PEffort : parameter
  | PSize : parameter
  | PAspectRatio : parameter
  | PQuality : parameter
  | PBackground : parameter
  | PJudgeModel : parameter
  | PJudgeEffort : parameter
  | PJudgeCriteria : parameter
  | PJudgeSystem : parameter
  | PVariable : parameter

let common_parameter = p: parameter{p <> PVariable}

type value =
  | InputValue : list message -> value
  | ModelValue : string -> value
  | EffortValue : effort -> value
  | SizeValue : string -> value
  | AspectRatioValue : string -> value
  | QualityValue : string -> value
  | BackgroundValue : string -> value
  | JudgeModelValue : string -> value
  | JudgeEffortValue : effort -> value
  | JudgeCriteriaValue : list criterion -> value
  | JudgeSystemValue : string -> value
  | VariableValue : list (option variable_field) -> value

let value_parameter (v: value) : Tot parameter =
  match v with
  | InputValue _ -> PInput
  | ModelValue _ -> PModel
  | EffortValue _ -> PEffort
  | SizeValue _ -> PSize
  | AspectRatioValue _ -> PAspectRatio
  | QualityValue _ -> PQuality
  | BackgroundValue _ -> PBackground
  | JudgeModelValue _ -> PJudgeModel
  | JudgeEffortValue _ -> PJudgeEffort
  | JudgeCriteriaValue _ -> PJudgeCriteria
  | JudgeSystemValue _ -> PJudgeSystem
  | VariableValue _ -> PVariable

let value_for (p: parameter) = v: value{value_parameter v = p}

let common_value = v: value{value_parameter v <> PVariable}

type source (p: common_parameter) =
  | Common : value_for p -> source p
  | OnAxis : axis -> source p

type parameter_sources = {
  source_order: list common_parameter;
  input_source: source PInput;
  model_source: source PModel;
  effort_source: option (source PEffort);
  size_source: option (source PSize);
  aspect_ratio_source: option (source PAspectRatio);
  quality_source: option (source PQuality);
  background_source: option (source PBackground);
  judge_model_source: option (source PJudgeModel);
  judge_effort_source: option (source PJudgeEffort);
  judge_criteria_source: option (source PJudgeCriteria);
  judge_system_source: option (source PJudgeSystem)
}

type case_values = {
  value_order: list parameter;
  input_value: option (list message);
  model_value: option string;
  effort_value: option effort;
  size_value: option string;
  aspect_ratio_value: option string;
  quality_value: option string;
  background_value: option string;
  judge_model_value: option string;
  judge_effort_value: option effort;
  judge_criteria_value: option (list criterion);
  judge_system_value: option string;
  variable_value: option (list (option variable_field))
}

type case_record = {
  case_id: string;
  case_name: option string;
  values: case_values
}

type variable_names = {
  row_names: option (list (option string));
  column_names: option (list (option string))
}

type layout = {
  output_format: format;
  case_ownership: case_axes;
  rows: list case_record;
  columns: list case_record;
  variable_names: option variable_names;
  parameters: parameter_sources;
  judging: bool;
  parallel_workers: option pos
}

type draft_input = {
  draft_layout: layout;
  budget_text: string
}

type draft = {
  format_selected: bool;
  editable: draft_input;
  source_grid_id: option string;
  reuse_artifacts: option bool
}

noeq type admitted_input = {
  admitted_layout: g: layout{g.rows <> [] /\ g.columns <> []};
  budget_usd: Number.positive
}

noeq type capability =
  | EnumCapability : list string -> capability
  | RangeCapability : minimum: Number.finite -> maximum: Number.finite -> capability
  | BooleanCapability : capability
  | OtherCapability : string -> capability

noeq type endpoint_price = {
  billable: string;
  unit: string;
  cost_usd: Number.nonnegative;
  variant: option string
}

noeq type image_endpoint = {
  provider_name: string;
  capabilities: list (string & capability);
  pricing: list endpoint_price
}

noeq type catalog_model = {
  model_id: string;
  alias_target: option string;
  canonical_slug: option string;
  model_name: string;
  generates_images: bool;
  accepts_images: bool;
  generates_text: bool;
  reasoning: bool;
  reasoning_mandatory: bool;
  structured_outputs: option bool;
  reasoning_efforts: option (list effort);
  image_endpoints: option (list image_endpoint)
}

type capacity =
  | CapacityPending : format -> option pos -> capacity
  | CapacityReady : format -> option pos -> capacity
  | CapacityError : format -> option pos -> capacity

type provider_observation = {
  connected: bool;
  capacity: capacity
}

noeq type context = {
  catalog: list catalog_model;
  provider: provider_observation
}

type initial = {
  initial_draft: draft;
  case_id_prefix: string
}

type message_edit =
  | MessageContent : index: nat -> content: string -> message_edit
  | InsertMessage : index: nat -> message_edit
  | RemoveMessage : index: nat -> message_edit
  | MoveMessage : index: nat -> target: nat -> message_edit
  | CycleRole : index: nat -> remembered_content: option string -> message_edit
  | AppendMessageImages : index: nat -> list reference_image -> message_edit
  | RemoveMessageImage : index: nat -> image_index: nat -> message_edit
  | PromptContent : string -> message_edit
  | AppendPromptImages : list reference_image -> message_edit
  | RemovePromptImage : image_index: nat -> message_edit

type input_target =
  | CommonInput : input_target
  | CaseInput : axis -> case_index: nat -> input_target

type scalar_parameter = p: common_parameter{p <> PInput /\ p <> PJudgeCriteria /\ p <> PJudgeSystem}

type input_action =
  | SetCommon : common_value -> input_action
  | SetCaseValue : axis -> index: nat -> value -> input_action
  | SetCaseValues : p: scalar_parameter -> axis -> list (value_for p) -> input_action
  | EditInput : input_target -> message_edit -> input_action
  | MoveToAxis : common_parameter -> axis -> input_action
  | MoveToCommon : common_parameter -> input_action
  | SelectDimension : axis -> parameter -> input_action
  | SingleDimension : axis -> input_action
  | AddCase : axis -> case_record -> input_action
  | RemoveCase : axis -> index: nat -> input_action
  | MoveCase : axis -> index: nat -> target: nat -> input_action
  | AddVariable : axis -> input_action
  | RemoveVariable : axis -> index: nat -> input_action
  | RenameVariable : axis -> index: nat -> name: string -> input_action
  | RenameCase : axis -> index: nat -> name: string -> input_action
  | SwapAxes : input_action
  | SetJudging : bool -> input_action

noeq type event =
  | InputAction : input_action -> event
  | SelectFormat : format -> event
  | ClearFormat : event
  | ChangeBudget : string -> event
  | ChangeArtifactReuse : bool -> event
  | ObserveProvider : provider_observation -> event
  | ReferenceUploaded : request_id: pos -> local_id: string -> reference_image -> event
  | UploadStatus : busy: bool -> event
  | ConfirmationResolved : confirmation_id: pos -> accepted: bool -> event
  | GenerateRequested : continue_low_balance: bool -> event
  | ReferencesPrepared : request_id: pos -> event
  | SubmissionSucceeded : request_id: pos -> grid_id: string -> event
  | SubmissionFailed :
      request_id: pos -> message: string -> balance: option Number.finite -> event
  | CompletionFailed : request_id: pos -> message: string -> event
  | DismissLowBalance : event

noeq type command =
  | PersistDraft : draft -> command
  | Confirm : confirmation_id: pos -> message: string -> command
  | PrepareReferences : request_id: pos -> admitted_input -> command
  | SubmitGrid :
      request_id: pos ->
      admitted_input ->
      source_grid_id: option string ->
      reuse_artifacts: bool ->
      continue_low_balance: bool ->
      command
  | CreationCompleted : request_id: pos -> grid_id: string -> command
  | NavigateHome : command
  | RemoveReferenceFile : local_id: string -> command

type path_segment =
  | Property : string -> path_segment
  | Index : nat -> path_segment

type validation_issue = {
  issue_message: string;
  issue_path: list path_segment;
  deferred: bool
}

type origin_source =
  | CommonOrigin : origin_source
  | AxisOrigin : axis -> origin_source

type origin = {
  origin_parameter: parameter;
  origin_source: origin_source;
  case_index: option nat;
  field_index: option nat;
  message_index: option nat
}

type support =
  | Unsupported : support
  | UnknownSupport : support

type compatibility_issue = {
  issue_row: nat;
  issue_column: nat;
  issue_parameters: list parameter;
  origins: list origin;
  support: support;
  blocking: bool;
  reason: string
}

type image_settings = {
  image_size: option string;
  image_aspect_ratio: option string;
  image_quality: option string;
  image_background: option string;
  input_references: option (list string)
}

type judge_preview = {
  judge_model: string;
  judge_effort: effort;
  criteria: option (list criterion)
}

noeq type preview_cell = {
  cell_row: nat;
  cell_column: nat;
  cell_model: string;
  cell_effort: effort;
  prompt: string;
  messages: option (list message);
  preview_budget: option Number.finite;
  image_settings: option image_settings;
  judge: option judge_preview
}

type submission_phase =
  | Idle : submission_phase
  | Preparing : submission_phase
  | Submitting : submission_phase
  | Completed : submission_phase

noeq type admission_decision =
  | CannotAttempt : reasons: list string -> admission_decision
  | IncompleteSelection : admission_decision
  | ReadyToSubmit : admitted_input -> admission_decision

noeq type policy = {
  validation_issues: list validation_issue;
  compatibility_issues: list compatibility_issue;
  compatibility_cells: list preview_cell;
  decision: admission_decision;
  selected_workers: option pos
}

noeq type view = {
  view_draft: draft;
  attempted: bool;
  pending_uploads: nat;
  error: string;
  low_balance: option Number.finite;
  submission_phase: submission_phase;
  policy: policy
}

type change =
  | NoChange : change
  | MetadataChanged : change
  | DraftChanged : change

noeq type output = {
  change: change;
  commands: list command
}

let can_attempt (decision: admission_decision) : Tot bool =
  match decision with
  | CannotAttempt _ -> false
  | IncompleteSelection -> true
  | ReadyToSubmit _ -> true

let can_submit (decision: admission_decision) : Tot bool =
  match decision with
  | ReadyToSubmit _ -> true
  | CannotAttempt _ -> false
  | IncompleteSelection -> false

let decision_reasons (decision: admission_decision) : Tot (list string) =
  match decision with
  | CannotAttempt reasons -> reasons
  | IncompleteSelection -> []
  | ReadyToSubmit _ -> []

let state_changed (change: change) : Tot bool =
  match change with
  | NoChange -> false
  | MetadataChanged -> true
  | DraftChanged -> true

let draft_changed (change: change) : Tot bool =
  match change with
  | DraftChanged -> true
  | NoChange -> false
  | MetadataChanged -> false
