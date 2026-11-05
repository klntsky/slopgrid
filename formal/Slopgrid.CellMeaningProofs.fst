module Slopgrid.CellMeaningProofs

(* A cell's meaning records expanded input text, message roles and images, and
   judge questions with their expected answers. These proofs compare those
   values after edits, rather than requiring identical template source text. *)

module Input = Slopgrid.Input
module CellMeaning = Slopgrid.CellMeaning
module Template = Slopgrid.Template
module TemplateProofs = Slopgrid.TemplateProofs
module List = FStar.List.Tot.Base
module Native = Slopgrid.Native
module CellSemantics = Slopgrid.CellSemantics
open Slopgrid.Domain

(* A valid rename keeps a prompt's expanded bytes if every renamed token still
   finds its original field. The ordered field lookups stay equal too, so image
   collection and missing-reference checks see the same fields.
   This is the text part of PRODUCT.md 3.3.2. *)
let text_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (content: string)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.text after (Input.rewrite_text rename content) == CellMeaning.text before content) =
  TemplateProofs.rewrite_expansion rename
    (CellMeaning.field_bytes before) (CellMeaning.field_bytes after) content;
  TemplateProofs.rewrite_resolution rename before after content

(* Renaming references keeps a message's role, expanded content, and attachments
   unchanged when the renamed tokens find the same fields. That also keeps the
   images contributed by references on that message. PRODUCT.md 3.3.2 and 3.3.4. *)
let message_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (message: message)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.message after
        {message with content = Input.rewrite_text rename message.content} ==
      CellMeaning.message before message) =
  text_rewrite rename before after message.content

(* Apply the same rename through the complete Chat history without moving
   messages or changing their roles and images. Every renamed lookup must still
   return its original field. PRODUCT.md 3.3.2. *)
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

(* Renaming a judge question keeps its expanded text and referenced images when
   renamed lookups agree. Its expected YES/NO answer stays attached to that
   question. PRODUCT.md 3.3.2. *)
let criterion_rewrite (rename: string -> Tot string{TemplateProofs.valid_renamer rename})
  (before: CellMeaning.environment) (after: CellMeaning.environment) (criterion: criterion)
  : Lemma
    (requires forall name. after (TemplateProofs.runtime_rename rename name) == before name)
    (ensures
      CellMeaning.criterion after
        {criterion with criterion_text = Input.rewrite_text rename criterion.criterion_text} ==
      CellMeaning.criterion before criterion) =
  text_rewrite rename before after criterion.criterion_text

(* Renaming references throughout a rubric keeps question order and each
   question's text, images, and expected answer under the same lookup assumption.
   PRODUCT.md 3.3.2. *)
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

(* Rename references inside the selected input or judge setting, without
   changing what the cell reads. Matching field lookups are required for text.
   Scalar settings and literal field values do not change. PRODUCT.md 3.3.2. *)
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

(* Expansion and reference collection use the same field lookups for each token.
   Equal lookups therefore keep both the expanded bytes and the ordered fields
   equal while this helper walks the split template. *)
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

(* A prompt or judge text reads the same bytes and fields when every lookup
   returns the same field. No template rewrite is needed in this step. *)
let text_environment (before: CellMeaning.environment) (after: CellMeaning.environment)
  (content: string)
  : Lemma
    (requires forall name. after name == before name)
    (ensures CellMeaning.text after content == CellMeaning.text before content) =
  match Template.split_dollar (Native.byte_view content) with
  | [] -> ()
  | _ :: parts -> parts_environment before after parts

(* Keeping all field lookups equal keeps the complete Chat history's meaning.
   Message order, roles, direct attachments, and referenced images stay equal. *)
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

(* The same field lookups keep a rubric's expanded questions and referenced
   images equal. Each question keeps its position and expected YES/NO answer. *)
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

(* Once a cell has selected a parameter value, identical field lookups leave its
   meaning unchanged. This covers prompts and judge text as well as settings
   with no template references. *)
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

(* No attachment list and an explicitly empty list both mean no images on a
   message. Normalizing that representation keeps the history's meaning, even
   when text references add images separately. PRODUCT.md 3.3.9. *)
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

(* Removing empty image lists does not change a prompt or Chat history's input.
   Model choices and judge settings keep their stored values. PRODUCT.md 3.3.9. *)
let value_canonical (env: CellMeaning.environment) (p: common_parameter) (value: value_for p)
  : Lemma
    (CellMeaning.value env (CellSemantics.canonical_value value) == CellMeaning.value env value) =
  match value with
  | InputValue messages -> messages_canonical env messages
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | JudgeCriteriaValue _
  | JudgeSystemValue _ -> ()

(* Values treated as equal for returning a case parameter to common have the
   same meaning when field lookups agree. Empty image-list representation may
   differ, but a missing value is not an empty input. This supports value
   comparison, not the whole conversion. PRODUCT.md 3.1.10 and 3.3.9. *)
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
