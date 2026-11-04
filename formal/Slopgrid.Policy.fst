module Slopgrid.Policy

module D = Slopgrid.Data
module L = FStar.List.Tot.Base
open FStar.List.Tot.Base
module B = Slopgrid.PolicyBase
module A = Slopgrid.PolicyAdmission
module C = Slopgrid.PolicyCompatibility

let evaluate (draft:D.json) (attempted:bool) (pending_uploads:nat) (submission_phase:string) (context:D.json) : Tot D.json =
  let input = D.get draft "input" in
  let provider = D.get context "provider" in
  let capacity = D.get provider "capacity" in
  let capacity_ready = D.str (D.get capacity "status") = "ready" && D.get capacity "format" = D.get input "format" in
  let workers = if D.str (D.get input "format") = "image" && capacity_ready then
    let cells = L.length (D.items (D.get input "rows")) * L.length (D.items (D.get input "columns")) in
    let available = if B.is_null (D.get capacity "parallelWorkers") then 1 else D.natural (D.get capacity "parallelWorkers") in
    let chosen = if cells < available then cells else available in
    D.number (if chosen < 1 then 1 else chosen)
    else D.JNull in
  let editable = D.omit input "parallelWorkers" in
  let editable = if B.is_null workers then editable else D.set editable "parallelWorkers" workers in
  let candidate,admitted,validation_issues = A.admit_input editable in
  let cells,compatibility_issues = C.analyze (A.preview candidate) (D.items (D.get context "catalog")) in
  let blocking_validation = L.filter (fun issue -> not (D.boolean (D.get issue "deferred"))) validation_issues in
  let blocking_compatibility = L.filter (fun issue -> D.boolean (D.get issue "blocking")) compatibility_issues in
  let busy = submission_phase = "submitting" || submission_phase = "completed" in
  let uploading = pending_uploads > 0 || submission_phase = "preparing" in
  let connected = D.boolean (D.get provider "connected") in
  let can_attempt = D.boolean (D.get draft "formatSelected") && connected && capacity_ready && not busy && not uploading && blocking_validation = [] && blocking_compatibility = [] in
  let can_submit = can_attempt && validation_issues = [] in
  let reasons =
    (if busy then ["Starting generation."] else []) @
    (if uploading then ["Uploading reference images."] else []) @
    (if not capacity_ready && connected then
      [if D.get capacity "format" = D.get input "format" && D.str (D.get capacity "status") = "error" then "Could not determine the automatic worker count." else "Checking the automatic worker count."] else []) @
    D.unique_strings (L.map (fun issue -> D.str (D.get issue "message")) blocking_validation) @
    D.unique_strings (L.map (fun issue -> D.str (D.get issue "reason")) blocking_compatibility) @
    (if connected then [] else ["Connect OpenRouter."]) in
  D.object [
    ("validationIssues",D.array (L.map (fun issue -> D.object [("message",D.get issue "message");("path",D.get issue "path")])
      (L.filter (fun issue -> attempted || not (D.boolean (D.get issue "deferred"))) validation_issues)));
    ("compatibilityIssues",D.array compatibility_issues);
    ("compatibilityCells",D.array cells);
    ("eligibility",D.object [("canAttempt",D.JBool can_attempt);("canSubmit",D.JBool can_submit);("reasons",D.array (L.map D.string reasons));("parallelWorkers",workers)]);
    ("admittedInput",(if can_submit then admitted else D.JNull))]
