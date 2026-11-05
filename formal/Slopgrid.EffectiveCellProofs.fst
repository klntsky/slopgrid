module Slopgrid.EffectiveCellProofs

module I = Slopgrid.Input
module S = Slopgrid.CellSemantics
module V = Slopgrid.VariableSemantics
module M = Slopgrid.CellMeaning
module MP = Slopgrid.CellMeaningProofs
module F = Slopgrid.TransposeLayoutProofs
module ST = Slopgrid.SemanticTranspose
module T = Slopgrid.Template
open Slopgrid.Domain

#push-options "--fuel 16"
(* Every common-capable parameter occurs in the list used to build cell meanings. *)
let all_parameters_complete (p:common_parameter)
  : Lemma (FStar.List.Tot.Base.mem p M.all_parameters) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem ->
    assert_norm (FStar.List.Tot.Base.mem p M.all_parameters)
#pop-options

(* Swapping a layout and exchanging row and column coordinates preserves a
   parameter's optional interpreted meaning, including rewritten template
   expansion and field resolution; no in-bounds assumption is required. *)
let parameter_swap (input:layout) (row:nat) (column:nat) (p:common_parameter)
  : Lemma (M.parameter (I.swap input) column row p == M.parameter input row column p) =
  ST.swap_rename_valid input;
  FStar.Classical.forall_intro (ST.field_for_swap input row column);
  F.swap_coordinate_correspondence input row column p;
  match S.resolve input row column p with
  | None -> ()
  | Some value -> MP.value_rewrite (I.swap_rename input)
      (V.field_for input row column) (V.field_for (I.swap input) column row) value

(* Swapping coordinates with the layout preserves the ordered list of parameter
   names paired with their optional interpreted meanings for any parameter list. *)
let rec parameters_swap (input:layout) (row:nat) (column:nat) (parameters:list common_parameter)
  : Lemma (T.map_g (fun p -> (p,M.parameter (I.swap input) column row p)) parameters ==
    T.map_g (fun p -> (p,M.parameter input row column p)) parameters) =
  match parameters with | [] -> () | p::rest ->
    parameter_swap input row column p;
    parameters_swap input row column rest

(* A layout swap with exchanged coordinates preserves the full cell meaning:
   format, judging, worker settings, and all interpreted parameter values.
   This is equality of the meaning projection, not of the source layout. *)
let cell_swap (input:layout) (row:nat) (column:nat)
  : Lemma (M.cell (I.swap input) column row == M.cell input row column) =
  F.swap_preserves_global_settings input;
  parameters_swap input row column M.all_parameters;
  assert_norm ((M.cell (I.swap input) column row).cell_parameters ==
    T.map_g (fun p -> (p,M.parameter (I.swap input) column row p)) M.all_parameters);
  assert_norm ((M.cell input row column).cell_parameters ==
    T.map_g (fun p -> (p,M.parameter input row column p)) M.all_parameters)

(* Swapping twice preserves the full cell meaning at the original coordinates,
   without asserting literal equality of the twice-swapped layout. *)
let cell_double_swap (input:layout) (row:nat) (column:nat)
  : Lemma (M.cell (I.swap (I.swap input)) row column == M.cell input row column) =
  cell_swap (I.swap input) column row;
  cell_swap input row column

(* Swapping the layout and coordinates leaves the cell's template-validity
   Boolean unchanged; it does not assert that either cell is valid. *)
let template_validity_swap (input:layout) (row:nat) (column:nat)
  : Lemma (M.templates_valid (M.cell (I.swap input) column row) ==
    M.templates_valid (M.cell input row column)) =
  cell_swap input row column

(* Swapping the layout and coordinates preserves the observable-cell projection:
   both sides are absent for template-invalid cells, or contain identical cell
   meanings when their templates are valid. *)
let observable_cell_swap (input:layout) (row:nat) (column:nat)
  : Lemma (M.observable_cell (I.swap input) column row == M.observable_cell input row column) =
  cell_swap input row column

(* Swapping twice preserves the observable-cell projection at the original
   coordinates, including both validity gating and the returned cell meaning. *)
let observable_cell_double_swap (input:layout) (row:nat) (column:nat)
  : Lemma (M.observable_cell (I.swap (I.swap input)) row column == M.observable_cell input row column) =
  cell_double_swap input row column
