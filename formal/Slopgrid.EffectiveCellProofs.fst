module Slopgrid.EffectiveCellProofs

(* Select each cell's shared, row-owned, or column-owned value before expanding
   its references. A row-owned prompt can still read COLUMN fields.
   These proofs compare the resulting inputs and judge settings after Swap,
   not just the raw values stored on each axis. PRODUCT.md 3.3.9. *)

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
(* Compare every parameter with a shared control. A swap must not skip a
   changed prompt or judge rubric because this list forgot its key. *)
let all_parameters_complete (p: common_parameter)
  : Lemma (List.mem p CellMeaning.all_parameters) =
  match p with
  | PInput | PModel | PEffort | PSize | PAspectRatio | PQuality | PBackground
  | PJudgeModel | PJudgeEffort | PJudgeCriteria | PJudgeSystem ->
    assert_norm (List.mem p CellMeaning.all_parameters)
#pop-options

(* Swap moves the parameter's owner and its variable bindings together. At the
   exchanged coordinates, its selected value expands to the same text and
   images, even for opposite-axis references. PRODUCT.md 3.3.7 and 3.3.9.
   The equality also covers absent values outside the layout bounds. *)
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

(* Collect the per-setting Swap result without changing the list's order.
   Each key stays paired with the same optional expanded value. *)
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

(* Swap keeps the cell's complete input, expanded judge rubric, and settings
   when row and column coordinates exchange places. Format, judging status, and
   worker count stay equal too. The stored layout need not be identical.
   This is the cell-meaning part of PRODUCT.md 3.3.7 and 3.8.9. *)
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

(* Two swaps restore the cell's input and judge settings at its original
   coordinates. This compares meaning, not layout bookkeeping or editor order.
   PRODUCT.md 3.3.7. *)
let cell_double_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.cell (Input.swap (Input.swap input)) row column ==
      CellMeaning.cell input row column) =
  cell_swap (Input.swap input) column row;
  cell_swap input row column

(* Swap neither fixes nor breaks this cell's template checks. Missing references
   and references that put images in disallowed text positions give the same
   result at the exchanged coordinates. This is not full submission validity.
   PRODUCT.md 3.3.6 and 3.3.7. *)
let template_validity_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.templates_valid (CellMeaning.cell (Input.swap input) column row) ==
      CellMeaning.templates_valid (CellMeaning.cell input row column)) =
  cell_swap input row column

(* The observed cell is absent when its template checks fail. Otherwise it holds
   the cell's input and settings. Swap preserves both outcomes.
   These checks do not cover every missing parameter or model compatibility
   rule. This is the template-observation part of PRODUCT.md 3.3.7. *)
let observable_cell_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.observable_cell (Input.swap input) column row ==
      CellMeaning.observable_cell input row column) =
  cell_swap input row column

(* After two swaps, observing the original coordinates gives the same input and
   settings, or the same failed template checks. It does not turn an invalid
   setup into a valid one. PRODUCT.md 3.3.7. *)
let observable_cell_double_swap (input: layout) (row: nat) (column: nat)
  : Lemma
    (CellMeaning.observable_cell (Input.swap (Input.swap input)) row column ==
      CellMeaning.observable_cell input row column) =
  cell_double_swap input row column
