module Slopgrid.Policy

module Domain = Slopgrid.Domain

val evaluate :
  draft: Domain.draft ->
  attempted: bool ->
  pending_uploads: nat ->
  submission_phase: Domain.submission_phase ->
  context: Domain.context ->
  Tot Domain.policy
