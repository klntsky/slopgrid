module Slopgrid.TransposeLayoutProofs

module Input = Slopgrid.Input
module CellSemantics = Slopgrid.CellSemantics
module List = FStar.List.Tot.Base
module VariableSemantics = Slopgrid.VariableSemantics
open Slopgrid.Domain

let rewrite_optional (rename: string -> Tot string) (p: common_parameter)
  (value: option (value_for p)) : Tot (option (value_for p)) =
  match value with
  | None -> None
  | Some value -> Some (Input.rewrite_value rename value)

let rewrite_owner (rename: string -> Tot string) (#p: common_parameter)
  (owner: source p) : Tot (source p) =
  match owner with
  | Common value -> Common (Input.rewrite_value rename value)
  | OnAxis side -> OnAxis side

(* Projecting a parameter from rewritten case values equals rewriting its
   optional projected value; an absent value stays absent. *)
let rewrite_case_projection (rename: string -> Tot string) (values: case_values)
  (p: common_parameter)
  : Lemma
    (CellSemantics.case_value (Input.rewrite_case_values rename values) p ==
      rewrite_optional rename p (CellSemantics.case_value values p)) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* Source lookup commutes with reference rewriting: common values are
   rewritten, axis owners are unchanged, and absent sources remain absent. *)
let rewrite_source_projection (rename: string -> Tot string) (sources: parameter_sources)
  (p: common_parameter)
  : Lemma
    (CellSemantics.source_for (Input.rewrite_sources rename sources) p ==
      (match CellSemantics.source_for sources p with
       | None -> None
       | Some owner -> Some (rewrite_owner rename owner))) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* Rewriting case values in every entry preserves indexed lookup: a found
   record differs only by the specified value rewrite, and absence is preserved. *)
let rec rewritten_entry (rename: string -> Tot string) (entries: list case_record) (index: nat)
  : Lemma
    (CellSemantics.entry_at
      (Input.map_preserving
        (fun entry -> {entry with values = Input.rewrite_case_values rename entry.values}) entries)
      index ==
    (match CellSemantics.entry_at entries index with
     | None -> None
     | Some entry -> Some {entry with values = Input.rewrite_case_values rename entry.values})) =
  match entries with
  | [] -> ()
  | _ :: rest ->
    if index = 0 then
      ()
    else
      rewritten_entry rename rest (index - 1)

(* Projecting a parameter at an axis index after reference rewriting equals
   rewriting the original optional axis value. *)
let rewrite_axis_projection (input: layout) (rename: string -> Tot string) (side: axis)
  (index: nat) (p: common_parameter)
  : Lemma
    (CellSemantics.axis_value (Input.rewrite_references input rename) side index p ==
      rewrite_optional rename p (CellSemantics.axis_value input side index p)) =
  (match side with
   | Rows -> rewritten_entry rename input.rows index
   | Columns -> rewritten_entry rename input.columns index);
  match CellSemantics.entry_at (CellSemantics.axis_entries input side) index with
  | None -> ()
  | Some entry -> rewrite_case_projection rename entry.values p

(* Resolving a parameter at fixed coordinates commutes with reference
   rewriting, including missing sources or axis values. *)
let rewrite_resolution (input: layout) (rename: string -> Tot string) (row: nat) (column: nat)
  (p: common_parameter)
  : Lemma
    (CellSemantics.resolve (Input.rewrite_references input rename) row column p ==
      rewrite_optional rename p (CellSemantics.resolve input row column p)) =
  rewrite_source_projection rename input.parameters p;
  match CellSemantics.source_for input.parameters p with
  | None | Some (Common _) -> ()
  | Some (OnAxis Rows) -> rewrite_axis_projection input rename Rows row p
  | Some (OnAxis Columns) -> rewrite_axis_projection input rename Columns column p

(* Source projection after swapping sources preserves common values and
   absence, and flips the owner of each axis-owned parameter. *)
let swap_source_projection (sources: parameter_sources) (p: common_parameter)
  : Lemma
    (CellSemantics.source_for (Input.swap_sources sources) p ==
      (match CellSemantics.source_for sources p with
       | None -> None
       | Some owner -> Some (Input.swap_source owner))) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* A parameter value at a given axis index moves to the opposite axis at
   the same index, with references rewritten by the layout's swap renamer. *)
let swap_axis_projection (input: layout) (side: axis) (index: nat) (p: common_parameter)
  : Lemma
    (CellSemantics.axis_value (Input.swap input) (Input.other_side side) index p ==
      rewrite_optional (Input.swap_rename input) p (CellSemantics.axis_value input side index p)) =
  rewrite_axis_projection input (Input.swap_rename input) side index p;
  match side with
  | Rows | Columns -> ()

(* Resolving a parameter after transposition at exchanged row/column
   coordinates equals rewriting the original optional resolved value.
   This is a resolution claim, not equality of all layout metadata. *)
let swap_coordinate_correspondence (input: layout) (row: nat) (column: nat) (p: common_parameter)
  : Lemma
    (CellSemantics.resolve (Input.swap input) column row p ==
      rewrite_optional (Input.swap_rename input) p (CellSemantics.resolve input row column p)) =
  swap_source_projection (Input.rewrite_sources (Input.swap_rename input) input.parameters) p;
  rewrite_source_projection (Input.swap_rename input) input.parameters p;
  match CellSemantics.source_for input.parameters p with
  | None | Some (Common _) -> ()
  | Some (OnAxis Rows) -> swap_axis_projection input Rows row p
  | Some (OnAxis Columns) -> swap_axis_projection input Columns column p

(* Transposition leaves output format, judging settings, and parallel worker
   count exactly unchanged. *)
let swap_preserves_global_settings (input: layout)
  : Lemma
    ((Input.swap input).output_format == input.output_format /\
      (Input.swap input).judging == input.judging /\
      (Input.swap input).parallel_workers == input.parallel_workers) = ()

(* The first-entry variable-field list moves unchanged to the opposite
   axis under transposition, including its absent-field positions. *)
let variable_fields_swap (input: layout) (side: axis)
  : Lemma
    (VariableSemantics.fields (Input.swap input) (Input.other_side side) ==
      VariableSemantics.fields input side) =
  match side with
  | Rows | Columns -> ()

#push-options "--fuel 4"
(* Looking up a variable field after exchanging coordinates and flipping
   its axis returns the exact same optional field at the same field index. *)
let variable_field_at_swap (input: layout) (row: nat) (column: nat) (side: axis) (index: nat)
  : Lemma
    (VariableSemantics.field_at (Input.swap input) column row (Input.other_side side) index ==
      VariableSemantics.field_at input row column side index) =
  (match side with
   | Rows ->
     assert_norm
       (CellSemantics.axis_entries (Input.swap input) Columns ==
         Input.map_preserving
           (fun entry -> {
             entry with
             values = Input.rewrite_case_values (Input.swap_rename input) entry.values
           }) input.rows)
   | Columns ->
     assert_norm
       (CellSemantics.axis_entries (Input.swap input) Rows ==
         Input.map_preserving
           (fun entry -> {
             entry with
             values = Input.rewrite_case_values (Input.swap_rename input) entry.values
           }) input.columns));
  assert
    ((if Input.other_side side = Rows then column else row) ==
      (if side = Rows then row else column));
  rewritten_entry (Input.swap_rename input) (CellSemantics.axis_entries input side)
    (if side = Rows then row else column);
  match CellSemantics.entry_at (CellSemantics.axis_entries input side)
    (if side = Rows then row else column) with
  | None -> ()
  | Some entry -> ()
#pop-options
