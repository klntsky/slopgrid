module Slopgrid.Data

module L = FStar.List.Tot.Base
module N = Slopgrid.Native

type json =
  | JNull : json
  | JBool : bool -> json
  | JNumber : string -> json
  | JString : string -> json
  | JArray : list json -> json
  | JObject : list (string & json) -> json

let items (value:json) : Tot (list json) =
  match value with | JArray values -> values | _ -> []

let fields (value:json) : Tot (list (string & json)) =
  match value with | JObject values -> values | _ -> []

let str (value:json) : Tot string =
  match value with | JString text -> text | _ -> ""

let boolean (value:json) : Tot bool =
  match value with | JBool flag -> flag | _ -> false

let natural (value:json) : Tot nat =
  match value with
  | JNumber text -> (match N.parse_nat text with | Some n -> n | None -> 0)
  | _ -> 0

let number (value:nat) : Tot json = JNumber (N.nat_string value)

let rec lookup (entries:list (string & json)) (key:string) : Tot json =
  match entries with
  | [] -> JNull
  | (name,value)::rest -> if name = key then value else lookup rest key

let get (value:json) (key:string) : Tot json = lookup (fields value) key

let rec has_field (entries:list (string & json)) (key:string) : Tot bool =
  match entries with
  | [] -> false
  | (name,_)::rest -> name = key || has_field rest key

let has (value:json) (key:string) : Tot bool = has_field (fields value) key

let rec set_field (entries:list (string & json)) (key:string) (value:json)
  : Tot (list (string & json)) =
  match entries with
  | [] -> [(key,value)]
  | (name,previous)::rest ->
    if name = key then (key,value)::rest
    else (name,previous)::set_field rest key value

let set (target:json) (key:string) (value:json) : Tot json =
  JObject (set_field (fields target) key value)

let omit (target:json) (key:string) : Tot json =
  JObject (L.filter (fun entry -> fst entry <> key) (fields target))

let strings (value:json) : Tot (list string) = L.map str (items value)

let rec at (values:list json) (index:nat) : Tot json =
  match values with
  | [] -> JNull
  | value::rest -> if index = 0 then value else at rest (index - 1)

let rec replace_at (values:list json) (index:nat) (value:json) : Tot (list json) =
  match values with
  | [] -> []
  | previous::rest ->
    if index = 0 then value::rest
    else previous::replace_at rest (index - 1) value

let rec insert_at (values:list json) (index:nat) (value:json) : Tot (list json) =
  if index = 0 then value::values
  else match values with
    | [] -> [value]
    | previous::rest -> previous::insert_at rest (index - 1) value

let rec remove_at (values:list json) (index:nat) : Tot (list json) =
  match values with
  | [] -> []
  | previous::rest ->
    if index = 0 then rest else previous::remove_at rest (index - 1)

let move (values:list json) (index:nat) (target:nat) : Tot (list json) =
  if index >= L.length values || target >= L.length values || index = target
  then values
  else insert_at (remove_at values index) target (at values index)

let rec equal (left:json) (right:json) : Tot bool (decreases left) =
  match left,right with
  | JNull,JNull -> true
  | JBool a,JBool b -> a = b
  | JNumber a,JNumber b -> N.compare_number a b = 0
  | JString a,JString b -> a = b
  | JArray a,JArray b -> equal_arrays a b
  | JObject a,JObject b ->
    L.length a = L.length b && equal_fields a b
  | _,_ -> false
and equal_arrays (left:list json) (right:list json)
  : Tot bool (decreases left) =
  match left,right with
  | [],[] -> true
  | a::rest_a,b::rest_b -> equal a b && equal_arrays rest_a rest_b
  | _,_ -> false
and equal_fields (left:list (string & json)) (right:list (string & json))
  : Tot bool (decreases left) =
  match left with
  | [] -> true
  | (key,value)::rest ->
    has_field right key && equal value (lookup right key) && equal_fields rest right

let rec join (separator:string) (values:list string) : Tot string =
  match values with
  | [] -> ""
  | [value] -> value
  | value::rest -> N.concat value (N.concat separator (join separator rest))

let unique_strings (values:list string) : Tot (list string) =
  let rec collect (remaining:list string) (seen:list string) : Tot (list string)
    (decreases remaining) =
    match remaining with
    | [] -> []
    | value::rest ->
      if L.mem value seen then collect rest seen
      else value::collect rest (value::seen)
  in collect values []

let object (entries:list (string & json)) : Tot json = JObject entries
let array (values:list json) : Tot json = JArray values
let string (value:string) : Tot json = JString value
