module Slopgrid.EffectiveCellProofs

module Input = Slopgrid.Input
module CellSemantics = Slopgrid.CellSemantics
module VariableSemantics = Slopgrid.VariableSemantics
module CellMeaning = Slopgrid.CellMeaning
module CellMeaningProofs = Slopgrid.CellMeaningProofs
module TransposeLayoutProofs = Slopgrid.TransposeLayoutProofs
module SemanticTranspose = Slopgrid.SemanticTranspose
module Template = Slopgrid.Template
module List = FStar.List.Tot.Base
open Slopgrid.Domain

#push-options "--fuel 16"
(* Every common-capable parameter occurs in the list used to build cell meanings. *)
let all_parameters_complete (p: common_parameter)
  : Lemma (List.mem p CellMeaning.all_parameters) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem ->
    assert_norm (List.mem p CellMeaning.all_parameters)
#pop-options

(* Swapping a layout and exchanging row and column coordinates preserves a
   parameter's optional interpreted meaning, including rewritten template
   expansion and field resolution; no in-bounds assumption is required. *)
let parameter_swap (input: layout) (row: nat) (column: nat) (p: common_parameter)
  : Lemma
    (CellMeaning.parameter (Input.swap input) column row p ==
      CellMeaning.parameter input row column p) =
  SemanticTranspose.swap_rename_valid input;
  FStar.Classical.forall_intro (SemanticTranspose.field_for_swap input row column);
  TransposeLayoutProofs.swap_coordinate_correspondence input row column p;
  match CellSemantics.resolve input row column p with
  | None -> ()
  | Some value ->
    CellMeaningProofs.value_rewrite (Input.swap_rename input)
      (VariableSemantics.field_for input row column)
      (VariableSemantics.field_for (Input.swap input) column row) value

(* Swapping coordinates with the layout preserves the ordered list of parameter
   names paired with their optional interpreted meanings for any parameter list. *)
let rec parameters_swap (input: layout) (row: nat) (column: nat)
  (parameters: list common_parameter)
  : Lemma
    (Template.map_g
      (fun p -> (p, CellMeaning.parameter (Input.swap input) column row p)) parameters ==
    Template.map_g (fun p -> (p, CellMeaning.parameter input row column p)) parameters) =
  match parameters with
  | [] -> ()
  | p :: rest ->
    parameter_swap input row column p;
    parameters_swap input row column rest

(* A layout swap with exchanged coordinates preserves the full cell meaning:
   format, judging, worker settings, and all interpreted parameter values.
   This is equality of the meaning projection, not of the source layout. *)
let cell_swap (input: layout) (row: nat) (column: nat)
  : Lemma (CellMeaning.cell (Input.swap input) column row == CellMeaning.cell input row column) =
  TransposeLayoutProofs.swap_preserves_global_settings input;
  parameters_swap input row column CellMeaning.all_parameters;
  assert_norm
    ((CellMeaning.cell (Input.swap input) column row).cell_parameters ==
      Template.map_g (fun p -> (p, CellMeaning.parameter (Input.swap input) column row p))
        CellMeaning.all_parameters);
  assert_norm
    ((CellMeaning.cell input row column).cell_parameters ==
      Template.map_g (fun p -> (p, CellMeaning.parameter input row column p))
        CellMeaning.all_parameters)

(* Swapping twice preserves the full cell meaning at the original coordinates,
   without asserting literal equality of the twice-swapped layout. *)
let cell_double_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.cell (Input.swap (Input.swap input)) row column ==
      CellMeaning.cell input row column) =
  cell_swap (Input.swap input) column row;
  cell_swap input row column

(* Swapping the layout and coordinates leaves the cell's template-validity
   Boolean unchanged; it does not assert that either cell is valid. *)
let template_validity_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.templates_valid (CellMeaning.cell (Input.swap input) column row) ==
      CellMeaning.templates_valid (CellMeaning.cell input row column)) =
  cell_swap input row column

(* Swapping the layout and coordinates preserves the observable-cell projection:
   both sides are absent for template-invalid cells, or contain identical cell
   meanings when their templates are valid. *)
let observable_cell_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.observable_cell (Input.swap input) column row ==
      CellMeaning.observable_cell input row column) =
  cell_swap input row column

(* Swapping twice preserves the observable-cell projection at the original
   coordinates, including both validity gating and the returned cell meaning. *)
let observable_cell_double_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.observable_cell (Input.swap (Input.swap input)) row column ==
      CellMeaning.observable_cell input row column) =
  cell_double_swap input row column
