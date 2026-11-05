module Slopgrid.Policy

(* Evaluate setup feedback and readiness without side effects.
   attempted controls deferred validation feedback, not validity. The caller
   supplies current provider and upload state. This interface does not perform
   authoritative server submission checks. PRODUCT.md 3.4.1. *)

module Domain = Slopgrid.Domain

val evaluate :
  draft: Domain.draft ->
  attempted: bool ->
  pending_uploads: nat ->
  submission_phase: Domain.submission_phase ->
  context: Domain.context ->
  Tot Domain.policy
