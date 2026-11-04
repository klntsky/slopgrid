module Slopgrid.Machine

module D = Slopgrid.Data
module N = Slopgrid.Native
module L = FStar.List.Tot.Base
module I = Slopgrid.Input
module P = Slopgrid.Parameters
module Policy = Slopgrid.Policy

type phase =
  | Preparing : phase
  | Submitting : phase
  | Completed : phase

type submission = {
  request_id:pos;
  request_phase:phase;
  request_input:D.json;
  source_grid_id:option D.json;
  reuse_artifacts:bool;
  continue_low_balance:bool
}

type confirmation = { confirmation_id:pos; proposed_draft:D.json }

type state = {
  draft:D.json;
  attempted:bool;
  pending_uploads:nat;
  error:string;
  low_balance:D.json;
  active:option submission;
  case_prefix:string;
  next_case:nat;
  next_confirmation:pos;
  next_request:pos;
  pending_confirmation:option confirmation;
  context:D.json
}

type outcome = {
  state_changed:bool;
  draft_changed:b:bool{b ==> state_changed}
}

type step = { next_state:state; outcome:outcome; commands:list D.json }

let init (initial:D.json) (context:D.json) : Tot state = {
  draft=D.get initial "draft";
  attempted=false;
  pending_uploads=0;
  error="";
  low_balance=D.JNull;
  active=None;
  case_prefix=D.str (D.get initial "caseIdPrefix");
  next_case=0;
  next_confirmation=1;
  next_request=1;
  pending_confirmation=None;
  context=context
}

let phase_name (value:phase) : Tot string =
  match value with
  | Preparing -> "preparing"
  | Submitting -> "submitting"
  | Completed -> "completed"

let submission_phase (model:state) : Tot string =
  match model.active with | None -> "idle" | Some request -> phase_name request.request_phase

let has_submission (model:state) : Tot bool =
  match model.active with | None -> false | Some _ -> true

let owns (model:state) (id:nat) (expected:phase) : Tot bool =
  match model.active with
  | Some request -> request.request_id = id && request.request_phase = expected
  | None -> false

let owns_confirmation (model:state) (id:nat) : Tot bool =
  match model.pending_confirmation with
  | Some proposal -> proposal.confirmation_id = id
  | None -> false

let unchanged (model:state) : Tot step = {
  next_state=model;
  outcome={state_changed=false; draft_changed=false};
  commands=[]
}

let changed (model:state) (commands:list D.json) (draft_changed:bool) : Tot step = {
  next_state=model;
  outcome={state_changed=true; draft_changed=draft_changed};
  commands=commands
}

let command (name:string) (entries:list (string & D.json)) : Tot D.json =
  D.object (("type",D.JString name)::entries)

let edit (model:state) (draft:D.json) (next_case:nat) : Tot step =
  let different = not (D.equal draft model.draft) in
  let confirming = match model.pending_confirmation with | None -> false | Some _ -> true in
  if not different && not model.attempted && model.error = "" && not confirming
  then unchanged model
  else
    changed {
      model with
      draft=(if different then draft else model.draft);
      next_case=next_case;
      attempted=false;
      error="";
      pending_confirmation=None
    } (if different then [command "persist-draft" [("draft",draft)]] else []) different

let input_source (input:D.json) : Tot D.json = D.get (D.get input "parameters") "input"

let generator_messages (input:D.json) : Tot (list D.json) =
  let source = input_source input in
  if D.str (D.get source "kind") = "common"
  then D.items (D.get source "value")
  else L.flatten (L.map (fun entry -> D.items (D.get entry "input"))
    (D.items (D.get input (D.str (D.get source "kind")))))

let reference_images (input:D.json) : Tot (list D.json) =
  let messages = L.flatten (L.map (fun message -> D.items (D.get message "images"))
    (generator_messages input)) in
  let entries = L.append (D.items (D.get input "rows")) (D.items (D.get input "columns")) in
  let variables = L.flatten (L.map (fun entry ->
    L.flatten (L.map (fun field -> D.items (D.get field "images"))
      (D.items (D.get entry "variable")))) entries) in
  L.append messages variables

let contains_reference (input:D.json) (id:string) : Tot bool =
  L.existsb (fun image -> D.str (D.get image "id") = id) (reference_images input)

let has_local_references (input:D.json) : Tot bool =
  L.existsb (fun image -> N.starts_with (D.str (D.get image "id")) "local-")
    (reference_images input)

let replace_image_list (images:D.json) (local_id:string) (replacement:D.json) : Tot D.json =
  D.JArray (L.map (fun image ->
    if D.str (D.get image "id") = local_id then replacement else image) (D.items images))

let replace_attachment (value:D.json) (local_id:string) (replacement:D.json) : Tot D.json =
  if D.has value "images"
  then D.set value "images" (replace_image_list (D.get value "images") local_id replacement)
  else value

let replace_messages (messages:D.json) (local_id:string) (replacement:D.json) : Tot D.json =
  D.JArray (L.map (fun message -> replace_attachment message local_id replacement)
    (D.items messages))

let replace_references (input:D.json) (local_id:string) (replacement:D.json) : Tot D.json =
  let source = input_source input in
  let side = D.str (D.get source "kind") in
  let input =
    if side = "common" then
      D.set input "parameters" (D.set (D.get input "parameters") "input"
        (D.set source "value" (replace_messages (D.get source "value") local_id replacement)))
    else D.set input side (D.JArray (L.map (fun entry ->
      if D.has entry "input" then
        D.set entry "input" (replace_messages (D.get entry "input") local_id replacement)
      else entry) (D.items (D.get input side)))) in
  L.fold_left (fun result dimension ->
    D.set result dimension (D.JArray (L.map (fun entry ->
      if D.has entry "variable" then
        D.set entry "variable" (D.JArray (L.map
          (fun field -> replace_attachment field local_id replacement)
          (D.items (D.get entry "variable"))))
      else entry) (D.items (D.get result dimension))))) input ["rows";"columns"]

let generate (model:state) (continue_low_balance:bool) : Tot step =
  if has_submission model then unchanged model
  else
    let policy = Policy.evaluate model.draft model.attempted model.pending_uploads
      (submission_phase model) model.context in
    if not (D.boolean (D.get (D.get policy "eligibility") "canAttempt"))
    then unchanged model
    else
      let input = D.get policy "admittedInput" in
      if D.equal input D.JNull then
        if model.attempted then unchanged model
        else changed {model with attempted=true} [] false
      else
        let request = {
          request_id=model.next_request;
          request_phase=Preparing;
          request_input=input;
          source_grid_id=(if D.has model.draft "sourceGridId"
            then Some (D.get model.draft "sourceGridId") else None);
          reuse_artifacts=(not (D.has model.draft "reuseArtifacts") ||
            D.boolean (D.get model.draft "reuseArtifacts"));
          continue_low_balance=continue_low_balance
        } in
        changed {model with attempted=true; error=""; active=Some request;
          next_request=model.next_request + 1}
          [command "prepare-references" [("id",D.number request.request_id);("input",input)]] false

let references_prepared (model:state) (id:nat) : Tot step =
  if not (owns model id Preparing) then unchanged model
  else match model.active with
  | None -> unchanged model
  | Some request ->
    if has_local_references request.request_input then unchanged model
    else
      let entries = [
        ("id",D.number request.request_id);
        ("input",request.request_input);
        ("reuseArtifacts",D.JBool request.reuse_artifacts);
        ("continueWithLowBalance",D.JBool request.continue_low_balance)
      ] in
      let entries = match request.source_grid_id with
        | None -> entries | Some source -> L.append entries [("sourceGridId",source)] in
      changed {model with active=Some {request with request_phase=Submitting}}
        [command "submit-grid" entries] false

let submission_succeeded (model:state) (id:nat) (grid_id:string) : Tot step =
  if not (owns model id Submitting) then unchanged model
  else match model.active with
  | None -> unchanged model
  | Some request ->
    changed {model with low_balance=D.JNull;
      active=Some {request with request_phase=Completed}}
      [command "creation-completed" [("id",D.number id);("gridId",D.JString grid_id)]] false

let submission_failed (model:state) (id:nat) (message:string) (balance:D.json) : Tot step =
  match model.active with
  | None -> unchanged model
  | Some request ->
    if request.request_id <> id || request.request_phase = Completed then unchanged model
    else
      let low = not (D.equal balance D.JNull) in
      changed {model with active=None;
        error=(if low then "" else message);
        low_balance=(if low then balance else model.low_balance)} [] false

let completion_failed (model:state) (id:nat) (message:string) : Tot step =
  if not (owns model id Completed) then unchanged model
  else changed {model with active=None; error=message} [] false

let confirmation_resolved (model:state) (id:nat) (accepted:bool) : Tot step =
  if not (owns_confirmation model id) then unchanged model
  else match model.pending_confirmation with
  | None -> unchanged model
  | Some proposal ->
    if accepted then edit model proposal.proposed_draft model.next_case
    else changed {model with pending_confirmation=None} [] false

let reference_uploaded (model:state) (id:nat) (local_id:string) (image:D.json) : Tot step =
  if not (owns model id Preparing) then unchanged model
  else match model.active with
  | None -> unchanged model
  | Some request ->
    if not (N.starts_with local_id "local-") ||
      N.starts_with (D.str (D.get image "id")) "local-" ||
      not (contains_reference request.request_input local_id)
    then unchanged model
    else
      let input = replace_references request.request_input local_id image in
      let draft_input = D.get model.draft "input" in
      let result = if contains_reference draft_input local_id then
        edit model (D.set model.draft "input" (replace_references draft_input local_id image))
          model.next_case
        else unchanged model in
      changed {result.next_state with active=Some {request with request_input=input}}
        (L.append result.commands [command "remove-reference-file" [("localId",D.JString local_id)]])
        result.outcome.draft_changed

let propose_edit (model:state) (event:D.json) : Tot step =
  let draft,next_case,message =
    if D.str (D.get event "type") = "format-selected" then
      let next,counter,dropped = I.select_format model.draft
        (D.str (D.get event "format")) (D.get model.context "catalog")
        model.case_prefix model.next_case in
      let message = if L.length dropped = 0 then None else
        Some (N.concat "Changing format will discard incompatible or differing "
          (N.concat (D.join ", " (L.map P.parameter_name dropped))
            " settings and case values. Differing values that become common will return to their defaults. Continue?")) in
      next,counter,message
    else
      let previous = D.get model.draft "input" in
      let message = I.confirmation previous event in
      let input,counter = I.reduce previous event model.case_prefix model.next_case in
      if D.equal input previous then model.draft,model.next_case,None
      else D.set model.draft "input" input,counter,message in
  match message with
  | None -> edit model draft next_case
  | Some text ->
    let id = model.next_confirmation in
    changed {model with next_case=next_case; next_confirmation=id + 1;
      pending_confirmation=Some {confirmation_id=id; proposed_draft=draft}}
      [command "confirm" [("id",D.number id);("message",D.JString text)]] false

let update_step (model:state) (event:D.json) : Tot step =
  let kind = D.str (D.get event "type") in
  match kind with
  | "format-cleared" ->
    let result = edit model (D.set model.draft "formatSelected" (D.JBool false)) model.next_case in
    {result with commands=L.append result.commands [command "navigate-home" []]}
  | "budget-changed" ->
    edit model (D.set model.draft "input"
      (D.set (D.get model.draft "input") "budgetUsd" (D.get event "value"))) model.next_case
  | "reuse-artifacts-changed" ->
    edit model (D.set model.draft "reuseArtifacts" (D.get event "value")) model.next_case
  | "provider-observed" ->
    if D.equal (D.get model.context "provider") (D.get event "provider") then unchanged model
    else changed {model with context=D.set model.context "provider" (D.get event "provider")} [] false
  | "reference-uploaded" -> reference_uploaded model (D.natural (D.get event "id"))
    (D.str (D.get event "localId")) (D.get event "image")
  | "upload-status-changed" ->
    let pending = if D.boolean (D.get event "busy") then model.pending_uploads + 1
      else if model.pending_uploads = 0 then 0 else model.pending_uploads - 1 in
    if pending = model.pending_uploads then unchanged model
    else changed {model with pending_uploads=pending} [] false
  | "confirmation-resolved" -> confirmation_resolved model (D.natural (D.get event "id"))
    (D.boolean (D.get event "accepted"))
  | "generate-requested" -> generate model (D.boolean (D.get event "continueWithLowBalance"))
  | "references-prepared" -> references_prepared model (D.natural (D.get event "id"))
  | "submission-succeeded" -> submission_succeeded model (D.natural (D.get event "id"))
    (D.str (D.get event "gridId"))
  | "submission-failed" -> submission_failed model (D.natural (D.get event "id"))
    (D.str (D.get event "message")) (D.get event "balanceUsd")
  | "completion-failed" -> completion_failed model (D.natural (D.get event "id"))
    (D.str (D.get event "message"))
  | "low-balance-dismissed" ->
    if D.equal model.low_balance D.JNull then unchanged model
    else changed {model with low_balance=D.JNull} [] false
  | _ -> propose_edit model event

let update (model:state) (event:D.json) : Tot (state & D.json) =
  let result = update_step model event in
  result.next_state,D.object [
    ("outcome",D.object [
      ("stateChanged",D.JBool result.outcome.state_changed);
      ("draftChanged",D.JBool result.outcome.draft_changed)]);
    ("commands",D.JArray result.commands)]

let view (model:state) : Tot D.json =
  let phase = submission_phase model in
  let policy = Policy.evaluate model.draft model.attempted model.pending_uploads phase model.context in
  D.object [
    ("draft",model.draft);
    ("attempted",D.JBool model.attempted);
    ("pendingUploads",D.number model.pending_uploads);
    ("error",D.JString model.error);
    ("lowBalance",model.low_balance);
    ("submissionPhase",D.JString phase);
    ("validationIssues",D.get policy "validationIssues");
    ("compatibilityIssues",D.get policy "compatibilityIssues");
    ("compatibilityCells",D.get policy "compatibilityCells");
    ("eligibility",D.get policy "eligibility")]
