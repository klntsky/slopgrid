module Slopgrid.Policy

val evaluate :
  draft:Slopgrid.Data.json ->
  attempted:bool ->
  pending_uploads:nat ->
  submission_phase:string ->
  context:Slopgrid.Data.json ->
  Tot Slopgrid.Data.json
