module Slopgrid.CellMeaningProofs

module Input = Slopgrid.Input
module CellMeaning = Slopgrid.CellMeaning
module Template = Slopgrid.Template
module TemplateProofs = Slopgrid.TemplateProofs
module List = FStar.List.Tot.Base
module Native = Slopgrid.Native
module CellSemantics = Slopgrid.CellSemantics
open Slopgrid.Domain

(* A valid identifier renaming preserves expanded text bytes and ordered resolved
   fields when the new environment maps every renamed identifier to its original
   field. The claim is equality of meanings, not literal template strings. *)
let text_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (content: string)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.text after (Input.rewrite_text rename content) == CellMeaning.text before content) =
  TemplateProofs.rewrite_expansion rename
    (CellMeaning.field_bytes before) (CellMeaning.field_bytes after) content;
  TemplateProofs.rewrite_resolution rename before after content

(* Rewriting message references with a valid renamer preserves the full message
   meaning, including role and image projections, if renamed lookups return the
   original fields. *)
let message_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (message: message)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.message after
        {message with content = Input.rewrite_text rename message.content} ==
      CellMeaning.message before message) =
  text_rewrite rename before after message.content

(* Rewriting each message's references preserves the ordered list of message
   meanings under a valid renamer and corresponding renamed-field lookups. *)
let rec messages_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (messages: list message)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      Template.map_g (CellMeaning.message after)
        (List.map
          (fun message -> {message with content = Input.rewrite_text rename message.content})
          messages) ==
      Template.map_g (CellMeaning.message before) messages) =
  match messages with
  | [] -> ()
  | message :: rest ->
    message_rewrite rename before after message;
    messages_rewrite rename before after rest

(* Rewriting a criterion's references preserves its text meaning, expected
   answer, and derived images when a valid renaming preserves field lookups. *)
let criterion_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (criterion: criterion)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.criterion after
        {criterion with criterion_text = Input.rewrite_text rename criterion.criterion_text} ==
      CellMeaning.criterion before criterion) =
  text_rewrite rename before after criterion.criterion_text

(* Rewriting every criterion preserves the ordered list of criterion meanings
   under a valid renamer and corresponding renamed-field lookups. *)
let rec criteria_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (criteria: list criterion)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      Template.map_g (CellMeaning.criterion after)
        (List.map
          (fun criterion ->
            {criterion with criterion_text = Input.rewrite_text rename criterion.criterion_text})
          criteria) ==
      Template.map_g (CellMeaning.criterion before) criteria) =
  match criteria with
  | [] -> ()
  | criterion :: rest ->
    criterion_rewrite rename before after criterion;
    criteria_rewrite rename before after rest

(* Rewriting references throughout a parameter value preserves its interpreted
   meaning when identifier renaming is valid and the environments agree at
   corresponding names; scalar values are unchanged. *)
let value_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (value: value)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.value after (Input.rewrite_value rename value) == CellMeaning.value before value) =
  match value with
  | InputValue messages -> messages_rewrite rename before after messages
  | JudgeCriteriaValue criteria -> criteria_rewrite rename before after criteria
  | JudgeSystemValue content -> text_rewrite rename before after content
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | VariableValue _ -> ()

(* Pointwise-equal field environments produce identical expanded bytes and
   ordered field-resolution results for a list of template byte parts. *)
let rec parts_environment (before: CellMeaning.environment) (after: CellMeaning.environment)
  (parts: list (list Native.byte))
  : Lemma
    (requires forall name. after name == before name)
    (ensures
      Template.expand_parts (CellMeaning.field_bytes after) parts ==
        Template.expand_parts (CellMeaning.field_bytes before) parts /\
      Template.resolve_parts after parts == Template.resolve_parts before parts) =
  match parts with
  | [] -> ()
  | part :: rest ->
    parts_environment before after rest;
    match Template.reference_part part with
    | None -> ()
    | Some (name, _) -> ()

(* Pointwise-equal field environments give any text identical expanded bytes
   and ordered resolved fields. *)
let text_environment (before: CellMeaning.environment) (after: CellMeaning.environment)
  (content: string)
  : Lemma
    (requires forall name. after name == before name)
    (ensures CellMeaning.text after content == CellMeaning.text before content) =
  match Template.split_dollar (Native.byte_view content) with
  | [] -> ()
  | _ :: parts -> parts_environment before after parts

(* Pointwise-equal field environments preserve the ordered list of interpreted
   messages, including their content and image projections. *)
let rec messages_environment (before: CellMeaning.environment) (after: CellMeaning.environment)
  (messages: list message)
  : Lemma
    (requires forall name. after name == before name)
    (ensures
      Template.map_g (CellMeaning.message after) messages ==
      Template.map_g (CellMeaning.message before) messages) =
  match messages with
  | [] -> ()
  | message :: rest ->
    text_environment before after message.content;
    messages_environment before after rest

(* Pointwise-equal field environments preserve the ordered list of interpreted
   criteria, including their text and derived images. *)
let rec criteria_environment (before: CellMeaning.environment) (after: CellMeaning.environment)
  (criteria: list criterion)
  : Lemma
    (requires forall name. after name == before name)
    (ensures
      Template.map_g (CellMeaning.criterion after) criteria ==
      Template.map_g (CellMeaning.criterion before) criteria) =
  match criteria with
  | [] -> ()
  | criterion :: rest ->
    text_environment before after criterion.criterion_text;
    criteria_environment before after rest

(* Pointwise-equal field environments preserve the interpreted meaning of any
   parameter value, including values containing template text. *)
let value_environment (before: CellMeaning.environment) (after: CellMeaning.environment) (value: value)
  : Lemma
    (requires forall name. after name == before name)
    (ensures CellMeaning.value after value == CellMeaning.value before value) =
  match value with
  | InputValue messages -> messages_environment before after messages
  | JudgeCriteriaValue criteria -> criteria_environment before after criteria
  | JudgeSystemValue content -> text_environment before after content
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | VariableValue _ -> ()

(* Canonicalizing optional message image lists preserves all interpreted message
   meanings; absent images and an explicitly empty image list mean the same thing. *)
let rec messages_canonical (env: CellMeaning.environment) (messages: list message)
  : Lemma
    (Template.map_g (CellMeaning.message env) (CellSemantics.normalize_messages messages) ==
      Template.map_g (CellMeaning.message env) messages) =
  match messages with
  | [] -> ()
  | message :: rest ->
    messages_canonical env rest;
    match message.images with
    | None -> ()
    | Some images ->
      match images with
      | [] | _ :: _ -> ()

(* Canonicalizing a common-capable parameter value preserves its interpreted
   meaning in any field environment. *)
let value_canonical (env: CellMeaning.environment) (p: common_parameter) (value: value_for p)
  : Lemma
    (CellMeaning.value env (CellSemantics.canonical_value value) == CellMeaning.value env value) =
  match value with
  | InputValue messages -> messages_canonical env messages
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | JudgeCriteriaValue _
  | JudgeSystemValue _ -> ()

(* Semantically equivalent optional values of the same common-capable parameter
   yield identical optional meanings in pointwise-equal environments. This does
   not require literal equality of their unnormalized image-list metadata. *)
let equivalent_values (before: CellMeaning.environment) (after: CellMeaning.environment)
  (p: common_parameter) (left: option (value_for p)) (right: option (value_for p))
  : Lemma
    (requires
      CellSemantics.equivalent p left right /\
      (forall name. after name == before name))
    (ensures
      (match right with
       | None -> None
       | Some value -> Some (CellMeaning.value after value)) ==
      (match left with
       | None -> None
       | Some value -> Some (CellMeaning.value before value))) =
  match left, right with
  | None, None -> ()
  | Some left, Some right ->
    value_environment before after right;
    value_canonical before p left;
    value_canonical before p right
  | _ -> ()
