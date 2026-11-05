module Slopgrid.Number

new
val scalar : Type0

val is_finite : scalar -> Tot bool
val is_nan : scalar -> Tot bool
val lt : scalar -> scalar -> Tot bool
val ieee_equal : scalar -> scalar -> Tot bool
val parse : string -> Tot scalar
val render : scalar -> Tot string
val multiply : scalar -> scalar -> Tot scalar
val to_nat : scalar -> Tot (option nat)
val from_nat : nat -> Tot scalar
(* Trusted constant contract: the native zero scalar is finite. *)
val zero : n:scalar{is_finite n}

let finite = n:scalar{is_finite n}
let positive = n:finite{lt zero n}
let nonnegative = n:finite{not (lt n zero)}

(* Trusted numeric contract: converting a positive integer within this bound
   produces a finite, strictly positive native scalar. *)
val small_positive : n:pos{n <= 2147483647} -> Tot positive
