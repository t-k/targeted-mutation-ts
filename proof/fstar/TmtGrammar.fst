module TmtGrammar

module U8 = FStar.UInt8
module U32 = FStar.UInt32

type span = { first: U32.t; last: U32.t }
type candidate = {
  original: U32.t;
  replacement: U32.t;
  edit: span;
  left: span;
  right: span
}

let boundary (first: U8.t) (second: U8.t) : U32.t =
  if first = 60uy then (if second = 61uy then 2ul else 1ul)
  else if first = 62uy then (if second = 61uy then 4ul else 3ul)
  else 0ul

let flip (operator: U32.t) : U32.t =
  if operator = 1ul then 2ul
  else if operator = 2ul then 1ul
  else if operator = 3ul then 4ul
  else if operator = 4ul then 3ul
  else 0ul

let flip_involution (operator: U32.t)
  : Lemma (requires U32.v operator >= 1 /\ U32.v operator <= 4)
          (ensures flip (flip operator) == operator)
  = if operator = 1ul then () else if operator = 2ul then () else if operator = 3ul then () else U32.v_inj operator 4ul

let make_candidate (operator: U32.t) (edit: span) (left: span) (right: span) : candidate =
  { original = operator; replacement = flip operator; edit; left; right }

let identifier_start (ch: U8.t) : bool =
  if U8.(ch >=^ 65uy && ch <=^ 90uy) then true
  else if U8.(ch >=^ 97uy && ch <=^ 122uy) then true
  else ch = 36uy || ch = 95uy

let decimal_digit (ch: U8.t) : bool = U8.(ch >=^ 48uy && ch <=^ 57uy)
let identifier_continue (ch: U8.t) : bool = identifier_start ch || decimal_digit ch
let horizontal_space (ch: U8.t) : bool = ch = 32uy || ch = 9uy
let whitespace (ch: U8.t) : bool = horizontal_space ch || ch = 10uy || ch = 13uy

type byte_class =
  | Space
  | Identifier
  | DecimalDigits
  | HorizontalSpace

let in_class (cls:byte_class) (ch:U8.t) : bool =
  match cls with
  | Space -> whitespace ch
  | Identifier -> identifier_continue ch
  | DecimalDigits -> decimal_digit ch
  | HorizontalSpace -> horizontal_space ch
