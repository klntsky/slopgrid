module Slopgrid.Policy

val evaluate :
  draft:Slopgrid.Domain.draft ->
  attempted:bool ->
  pending_uploads:nat ->
  submission_phase:Slopgrid.Domain.submission_phase ->
  context:Slopgrid.Domain.context ->
  Tot Slopgrid.Domain.policy
