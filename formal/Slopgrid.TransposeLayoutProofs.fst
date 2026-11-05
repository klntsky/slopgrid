module Slopgrid.TransposeLayoutProofs

(* First select a cell's parameter from its common, row, or column owner.
   Swapping moves that owner and rewrites template text together. Expansion
   happens later: a row-owned prompt can still read a column variable.
   PRODUCT.md 3.1.4, 3.1.12, and 3.3.9. *)

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

(* Reading one parameter from a rewritten case returns its rewritten old
   value. A missing setting stays missing rather than becoming a default. *)
let rewrite_case_projection (rename: string -> Tot string) (values: case_values)
  (p: common_parameter)
  : Lemma
    (CellSemantics.case_value (Input.rewrite_case_values rename values) p ==
      rewrite_optional rename p (CellSemantics.case_value values p)) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* Rewriting a common prompt or judge text keeps its common owner. Row and
   column owners stay put until the separate axis-exchange step. *)
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

(* Rewrite every case in place without changing case order. Looking up a
   case still finds that same record with only its template-bearing values
   rewritten, or still finds no case at an out-of-range index. *)
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

(* At one case index, read the same parameter after rewriting its template
   references. This compares the selected value before variable expansion. *)
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

(* Choose the complete parameter value from its owner before comparing
   rewritten text. Missing owners and missing case values stay missing.
   No variable field can supply a different parameter owner. *)
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

(* The swap keeps common settings common and moves each case-owned parameter
   to the other axis. It does not fill in absent optional settings. *)
let swap_source_projection (sources: parameter_sources) (p: common_parameter)
  : Lemma
    (CellSemantics.source_for (Input.swap_sources sources) p ==
      (match CellSemantics.source_for sources p with
       | None -> None
       | Some owner -> Some (Input.swap_source owner))) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem -> ()

(* A row case becomes the column case at the same index, and vice versa.
   Its parameter value moves with it, with prompt and judge references
   rewritten for the moved fields. PRODUCT.md 3.1.12. *)
let swap_axis_projection (input: layout) (side: axis) (index: nat) (p: common_parameter)
  : Lemma
    (CellSemantics.axis_value (Input.swap input) (Input.other_side side) index p ==
      rewrite_optional (Input.swap_rename input) p (CellSemantics.axis_value input side index p)) =
  rewrite_axis_projection input (Input.swap_rename input) side index p;
  match side with
  | Rows | Columns -> ()

(* Read the old cell's selected parameter at exchanged coordinates.
   The result differs only by rewritten template references, before expansion.
   This is why selection must precede expansion. A row-owned prompt may read
   column fields. This is not equality of layout metadata. PRODUCT.md 3.1.4. *)
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

(* Swapping axes does not change the output format, judging toggle/settings
   record, or requested worker count. Axis-owned judge values are handled
   separately by parameter resolution, not by this global-settings claim. *)
let swap_preserves_global_settings (input: layout)
  : Lemma
    ((Input.swap input).output_format == input.output_format /\
      (Input.swap input).judging == input.judging /\
      (Input.swap input).parallel_workers == input.parallel_workers) = ()

(* The first case's field slots move unchanged to the other axis.
   Deleted slots remain empty at the same indexes, keeping numbered gaps.
   Field contents are literal data, not reference-rewrite targets.
   PRODUCT.md 3.3.4 and 3.3.7. *)
let variable_fields_swap (input: layout) (side: axis)
  : Lemma
    (VariableSemantics.fields (Input.swap input) (Input.other_side side) ==
      VariableSemantics.fields input side) =
  match side with
  | Rows | Columns -> ()

#push-options "--fuel 4"
(* Field values come from the row case for a row field and the column case
   for a column field. Flip both the field axis and cell coordinates to read
   the same optional field, with its text and images untouched.
   PRODUCT.md 3.3.7. *)
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
