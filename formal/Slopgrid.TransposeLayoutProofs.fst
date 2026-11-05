module Slopgrid.TransposeLayoutProofs

module I = Slopgrid.Input
module S = Slopgrid.CellSemantics
module L = FStar.List.Tot.Base
module V = Slopgrid.VariableSemantics
open Slopgrid.Domain

let rewrite_optional (rename:string -> Tot string) (p:common_parameter)
  (value:option (value_for p)) : Tot (option (value_for p)) =
  match value with | None -> None | Some value -> Some (I.rewrite_value rename value)

let rewrite_owner (rename:string -> Tot string) (#p:common_parameter)
  (owner:source p) : Tot (source p) =
  match owner with | Common value -> Common (I.rewrite_value rename value) | OnAxis side -> OnAxis side

(* Projecting a parameter from rewritten case values equals rewriting its
   optional projected value; an absent value stays absent. *)
let rewrite_case_projection (rename:string -> Tot string) (values:case_values) (p:common_parameter)
  : Lemma (S.case_value (I.rewrite_case_values rename values) p == rewrite_optional rename p (S.case_value values p)) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* Source lookup commutes with reference rewriting: common values are
   rewritten, axis owners are unchanged, and absent sources remain absent. *)
let rewrite_source_projection (rename:string -> Tot string) (sources:parameter_sources) (p:common_parameter)
  : Lemma (S.source_for (I.rewrite_sources rename sources) p ==
    (match S.source_for sources p with | None -> None | Some owner -> Some (rewrite_owner rename owner))) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* Rewriting case values in every entry preserves indexed lookup: a found
   record differs only by the specified value rewrite, and absence is preserved. *)
let rec rewritten_entry (rename:string -> Tot string) (entries:list case_record) (index:nat)
  : Lemma (S.entry_at (I.map_preserving (fun entry -> {entry with values=I.rewrite_case_values rename entry.values}) entries) index ==
    (match S.entry_at entries index with | None -> None | Some entry -> Some {entry with values=I.rewrite_case_values rename entry.values})) =
  match entries with | [] -> () | _::rest -> if index=0 then () else rewritten_entry rename rest (index - 1)

(* Projecting a parameter at an axis index after reference rewriting equals
   rewriting the original optional axis value. *)
let rewrite_axis_projection (input:layout) (rename:string -> Tot string) (side:axis) (index:nat) (p:common_parameter)
  : Lemma (S.axis_value (I.rewrite_references input rename) side index p == rewrite_optional rename p (S.axis_value input side index p)) =
  (match side with | Rows -> rewritten_entry rename input.rows index | Columns -> rewritten_entry rename input.columns index);
  match S.entry_at (S.axis_entries input side) index with
  | None -> () | Some entry -> rewrite_case_projection rename entry.values p

(* Resolving a parameter at fixed coordinates commutes with reference
   rewriting, including missing sources or axis values. *)
let rewrite_resolution (input:layout) (rename:string -> Tot string) (row:nat) (column:nat) (p:common_parameter)
  : Lemma (S.resolve (I.rewrite_references input rename) row column p == rewrite_optional rename p (S.resolve input row column p)) =
  rewrite_source_projection rename input.parameters p;
  match S.source_for input.parameters p with
  | None | Some (Common _) -> ()
  | Some (OnAxis Rows) -> rewrite_axis_projection input rename Rows row p
  | Some (OnAxis Columns) -> rewrite_axis_projection input rename Columns column p

(* Source projection after swapping sources preserves common values and
   absence, and flips the owner of each axis-owned parameter. *)
let swap_source_projection (sources:parameter_sources) (p:common_parameter)
  : Lemma (S.source_for (I.swap_sources sources) p ==
    (match S.source_for sources p with | None -> None | Some owner -> Some (I.swap_source owner))) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* A parameter value at a given axis index moves to the opposite axis at
   the same index, with references rewritten by the layout's swap renamer. *)
let swap_axis_projection (input:layout) (side:axis) (index:nat) (p:common_parameter)
  : Lemma (S.axis_value (I.swap input) (I.other_side side) index p ==
    rewrite_optional (I.swap_rename input) p (S.axis_value input side index p)) =
  rewrite_axis_projection input (I.swap_rename input) side index p;
  match side with | Rows | Columns -> ()

(* Resolving a parameter after transposition at exchanged row/column
   coordinates equals rewriting the original optional resolved value.
   This is a resolution claim, not equality of all layout metadata. *)
let swap_coordinate_correspondence (input:layout) (row:nat) (column:nat) (p:common_parameter)
  : Lemma (S.resolve (I.swap input) column row p ==
    rewrite_optional (I.swap_rename input) p (S.resolve input row column p)) =
  swap_source_projection (I.rewrite_sources (I.swap_rename input) input.parameters) p;
  rewrite_source_projection (I.swap_rename input) input.parameters p;
  match S.source_for input.parameters p with
  | None | Some (Common _) -> ()
  | Some (OnAxis Rows) -> swap_axis_projection input Rows row p
  | Some (OnAxis Columns) -> swap_axis_projection input Columns column p

(* Transposition leaves output format, judging settings, and parallel worker
   count exactly unchanged. *)
let swap_preserves_global_settings (input:layout)
  : Lemma ((I.swap input).output_format == input.output_format /\
    (I.swap input).judging == input.judging /\
    (I.swap input).parallel_workers == input.parallel_workers) = ()

(* The first-entry variable-field list moves unchanged to the opposite
   axis under transposition, including its absent-field positions. *)
let variable_fields_swap (input:layout) (side:axis)
  : Lemma (V.fields (I.swap input) (I.other_side side) == V.fields input side) =
  match side with | Rows | Columns -> ()

#push-options "--fuel 4"
(* Looking up a variable field after exchanging coordinates and flipping
   its axis returns the exact same optional field at the same field index. *)
let variable_field_at_swap (input:layout) (row:nat) (column:nat) (side:axis) (index:nat)
  : Lemma (V.field_at (I.swap input) column row (I.other_side side) index ==
    V.field_at input row column side index) =
  (match side with
   | Rows -> assert_norm (S.axis_entries (I.swap input) Columns ==
       I.map_preserving (fun entry -> {entry with values=I.rewrite_case_values (I.swap_rename input) entry.values}) input.rows)
   | Columns -> assert_norm (S.axis_entries (I.swap input) Rows ==
       I.map_preserving (fun entry -> {entry with values=I.rewrite_case_values (I.swap_rename input) entry.values}) input.columns));
  assert ((if I.other_side side=Rows then column else row) == (if side=Rows then row else column));
  rewritten_entry (I.swap_rename input) (S.axis_entries input side) (if side=Rows then row else column);
  match S.entry_at (S.axis_entries input side) (if side=Rows then row else column) with
  | None -> ()
  | Some entry -> ()
#pop-options
