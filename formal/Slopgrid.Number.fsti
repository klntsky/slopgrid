module Slopgrid.Number

(* Native floating-point numbers carry budget amounts and catalog prices.
   Parsing may produce NaN or infinity. Callers must check finiteness before
   constructing the checked number types below. F* assumes these operations
   follow their native contracts. It does not prove provider pricing. *)

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

(* Budget and price checks compare against this native zero. F* assumes that
   zero is finite. *)
val zero : n: scalar { is_finite n }

let finite = n: scalar { is_finite n }

let positive = n: finite { lt zero n }

let nonnegative = n: finite { not (lt n zero) }

(* Native code promises a finite positive result for small positive integers.
   There is no such promise here for conversion of an unbounded natural. *)
val small_positive : n: pos { n <= 2147483647 } -> Tot positive
