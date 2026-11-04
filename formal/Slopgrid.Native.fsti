module Slopgrid.Native

val length : string -> Tot nat
val slice : string -> nat -> nat -> Tot string
val char_at : string -> nat -> Tot string
val trim : string -> Tot string
val lower : string -> Tot string
val replace_all : string -> string -> string -> Tot string
val starts_with : string -> string -> Tot bool
val ends_with : string -> string -> Tot bool
val parse_number : string -> Tot (option string)
val positive_number : string -> Tot bool
val compare_number : string -> string -> Tot int
val parse_nat : string -> Tot (option nat)
val nat_string : nat -> Tot string
val concat : string -> string -> Tot string
val unicode_alphanumeric_at : string -> nat -> Tot bool
val multiply_number : string -> string -> Tot string
val number_kind : string -> Tot string
