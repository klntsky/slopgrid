module Slopgrid.CellMeaningProofs

module I = Slopgrid.Input
module M = Slopgrid.CellMeaning
module T = Slopgrid.Template
module TP = Slopgrid.TemplateProofs
module L = FStar.List.Tot.Base
open Slopgrid.Domain

let text_rewrite (rename:string -> Tot string{TP.valid_renamer rename})
  (before:M.environment) (after:M.environment) (content:string)
  : Lemma
    (requires forall name. after (TP.runtime_rename rename name) == before name)
    (ensures M.text after (I.rewrite_text rename content) == M.text before content) =
  TP.rewrite_expansion rename (M.field_bytes before) (M.field_bytes after) content;
  TP.rewrite_resolution rename before after content

let message_rewrite (rename:string -> Tot string{TP.valid_renamer rename})
  (before:M.environment) (after:M.environment) (message:message)
  : Lemma
    (requires forall name. after (TP.runtime_rename rename name) == before name)
    (ensures M.message after {message with content=I.rewrite_text rename message.content} == M.message before message) =
  text_rewrite rename before after message.content

let rec messages_rewrite (rename:string -> Tot string{TP.valid_renamer rename})
  (before:M.environment) (after:M.environment) (messages:list message)
  : Lemma
    (requires forall name. after (TP.runtime_rename rename name) == before name)
    (ensures T.map_g (M.message after) (L.map (fun message -> {message with content=I.rewrite_text rename message.content}) messages) ==
      T.map_g (M.message before) messages) =
  match messages with | [] -> () | message::rest ->
    message_rewrite rename before after message;
    messages_rewrite rename before after rest

let criterion_rewrite (rename:string -> Tot string{TP.valid_renamer rename})
  (before:M.environment) (after:M.environment) (criterion:criterion)
  : Lemma
    (requires forall name. after (TP.runtime_rename rename name) == before name)
    (ensures M.criterion after {criterion with criterion_text=I.rewrite_text rename criterion.criterion_text} == M.criterion before criterion) =
  text_rewrite rename before after criterion.criterion_text

let rec criteria_rewrite (rename:string -> Tot string{TP.valid_renamer rename})
  (before:M.environment) (after:M.environment) (criteria:list criterion)
  : Lemma
    (requires forall name. after (TP.runtime_rename rename name) == before name)
    (ensures T.map_g (M.criterion after) (L.map (fun criterion -> {criterion with criterion_text=I.rewrite_text rename criterion.criterion_text}) criteria) ==
      T.map_g (M.criterion before) criteria) =
  match criteria with | [] -> () | criterion::rest ->
    criterion_rewrite rename before after criterion;
    criteria_rewrite rename before after rest

let value_rewrite (rename:string -> Tot string{TP.valid_renamer rename})
  (before:M.environment) (after:M.environment) (value:value)
  : Lemma
    (requires forall name. after (TP.runtime_rename rename name) == before name)
    (ensures M.value after (I.rewrite_value rename value) == M.value before value) =
  match value with
  | InputValue messages -> messages_rewrite rename before after messages
  | JudgeCriteriaValue criteria -> criteria_rewrite rename before after criteria
  | JudgeSystemValue content -> text_rewrite rename before after content
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | VariableValue _ -> ()

let rec parts_environment (before:M.environment) (after:M.environment) (parts:list (list Slopgrid.Native.byte))
  : Lemma
    (requires forall name. after name == before name)
    (ensures T.expand_parts (M.field_bytes after) parts == T.expand_parts (M.field_bytes before) parts /\
      T.resolve_parts after parts == T.resolve_parts before parts) =
  match parts with | [] -> () | part::rest ->
    parts_environment before after rest;
    match T.reference_part part with | None -> () | Some (name,_) -> ()

let text_environment (before:M.environment) (after:M.environment) (content:string)
  : Lemma
    (requires forall name. after name == before name)
    (ensures M.text after content == M.text before content) =
  match T.split_dollar (Slopgrid.Native.byte_view content) with
  | [] -> () | _::parts -> parts_environment before after parts

let rec messages_environment (before:M.environment) (after:M.environment) (messages:list message)
  : Lemma
    (requires forall name. after name == before name)
    (ensures T.map_g (M.message after) messages == T.map_g (M.message before) messages) =
  match messages with | [] -> () | message::rest ->
    text_environment before after message.content;
    messages_environment before after rest

let rec criteria_environment (before:M.environment) (after:M.environment) (criteria:list criterion)
  : Lemma
    (requires forall name. after name == before name)
    (ensures T.map_g (M.criterion after) criteria == T.map_g (M.criterion before) criteria) =
  match criteria with | [] -> () | criterion::rest ->
    text_environment before after criterion.criterion_text;
    criteria_environment before after rest

let value_environment (before:M.environment) (after:M.environment) (value:value)
  : Lemma
    (requires forall name. after name == before name)
    (ensures M.value after value == M.value before value) =
  match value with
  | InputValue messages -> messages_environment before after messages
  | JudgeCriteriaValue criteria -> criteria_environment before after criteria
  | JudgeSystemValue content -> text_environment before after content
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | VariableValue _ -> ()

let rec messages_canonical (env:M.environment) (messages:list message)
  : Lemma (T.map_g (M.message env) (Slopgrid.CellSemantics.normalize_messages messages) ==
    T.map_g (M.message env) messages) =
  match messages with | [] -> () | message::rest ->
    messages_canonical env rest;
    match message.images with | None -> () | Some images -> match images with | [] | _::_ -> ()

let value_canonical (env:M.environment) (p:common_parameter) (value:value_for p)
  : Lemma (M.value env (Slopgrid.CellSemantics.canonical_value value) == M.value env value) =
  match value with
  | InputValue messages -> messages_canonical env messages
  | ModelValue _ | EffortValue _ | SizeValue _ | AspectRatioValue _ | QualityValue _
  | BackgroundValue _ | JudgeModelValue _ | JudgeEffortValue _ | JudgeCriteriaValue _
  | JudgeSystemValue _ -> ()

let equivalent_values (before:M.environment) (after:M.environment) (p:common_parameter)
  (left:option (value_for p)) (right:option (value_for p))
  : Lemma
    (requires Slopgrid.CellSemantics.equivalent p left right /\
      (forall name. after name == before name))
    (ensures (match right with | None -> None | Some value -> Some (M.value after value)) ==
      (match left with | None -> None | Some value -> Some (M.value before value))) =
  match left,right with
  | None,None -> ()
  | Some left,Some right ->
    value_environment before after right;
    value_canonical before p left;
    value_canonical before p right
  | _ -> ()
