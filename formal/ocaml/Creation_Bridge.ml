open Js_of_ocaml
module D = Slopgrid_Data
module M = Slopgrid_Machine

let number text =
  match Slopgrid_Native.parse_number text with
  | Some canonical -> D.JNumber canonical
  | None -> invalid_arg "Non-finite JSON number."

let rec decode = function
  | `Null -> D.JNull
  | `Bool value -> D.JBool value
  | `Int value -> number (string_of_int value)
  | `Intlit value -> number value
  | `Float value -> number (Yojson.Safe.to_string (`Float value))
  | `String value -> D.JString value
  | `List values -> D.JArray (List.map decode values)
  | `Assoc fields -> D.JObject (List.map (fun (key, value) -> key, decode value) fields)
  | `Tuple _ | `Variant _ -> invalid_arg "Expected standard JSON."

let rec encode = function
  | D.JNull -> `Null
  | D.JBool value -> `Bool value
  | D.JNumber value ->
      (match Slopgrid_Native.parse_number value with
       | Some canonical -> `Intlit canonical
       | None -> invalid_arg "Non-finite machine JSON number.")
  | D.JString value -> `String value
  | D.JArray values -> `List (List.map encode values)
  | D.JObject fields -> `Assoc (List.map (fun (key, value) -> key, encode value) fields)

let read_json value = decode (Yojson.Safe.from_string (Js.to_string value))
let write_json value = Js.string (Yojson.Safe.to_string (encode value))

let init initial context = Js.Unsafe.inject (M.init (read_json initial) (read_json context))
let update state event =
  let next, output = M.update (Obj.magic state) (read_json event) in
  Js.Unsafe.obj [|
    "state", Js.Unsafe.inject next;
    "output", Js.Unsafe.inject (write_json output)
  |]
let view state = write_json (M.view (Obj.magic state))

let () = Js.export "creationMachine" (Js.Unsafe.obj [|
  "init", Js.Unsafe.inject (Js.wrap_callback init);
  "update", Js.Unsafe.inject (Js.wrap_callback update);
  "view", Js.Unsafe.inject (Js.wrap_callback view)
|])
