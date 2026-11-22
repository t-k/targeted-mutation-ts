module TmtPulseParser
#lang-pulse

open Pulse.Lib.Pervasives
open TmtPulseMemory
module U8 = FStar.UInt8
module U32 = FStar.UInt32
module U64 = FStar.UInt64
module Cast = FStar.Int.Cast
module G = TmtGrammar
module A = Pulse.Lib.Array.Core
module Seq = FStar.Seq
module Size = FStar.SizeT
module S = TmtPulseScan

let class_code (cls:G.byte_class) : n:U8.t{U8.v n <= 2} =
  match cls with
  | G.Space -> 0uy
  | G.Identifier -> 1uy
  | G.DecimalDigits -> 2uy

let plus (value:U32.t) (amount:U32.t) : U32.t = U32.add_mod value amount
let minus (value:U32.t) (amount:U32.t) : U32.t = U32.sub_mod value amount

let same (input:tape) (#frame:slprop) (at:U32.t) (byte:U8.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! found = (fun () -> peek input #frame at) in
  read_ret input #frame (found = byte)

let next (at:U32.t) : U32.t = plus at 1ul

type cursor = { at:U32.t; ok:bool; newline:bool }

let line_break (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! ch = (fun () -> peek input #frame at) in
  if ch = 13uy || ch = 10uy then read_ret input #frame (true)
  else if ch = 226uy then separator input #frame at
  else read_ret input #frame (false)

let rec line_comment (input:tape) (#frame:slprop) (at:U32.t) (fuel:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if U32.(at >=^ input.size) then read_ret input #frame ({ at; ok = true; newline = false })
  else if fuel = 0ul then read_ret input #frame ({ at; ok = false; newline = false })
  else
    let! stop = (fun () -> line_break input #frame at) in
    if stop then read_ret input #frame ({ at; ok = true; newline = false })
    else line_comment input #frame (next at) (minus fuel 1ul)

let rec block_comment (input:tape) (#frame:slprop) (at:U32.t) (newline:bool) (fuel:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ input.size) then read_ret input #frame ({ at; ok = false; newline })
  else
    let! is_star = (fun () -> same input #frame at 42uy) in
    let! is_slash = (fun () -> same input #frame (next at) 47uy) in
    if is_star && is_slash then read_ret input #frame ({ at = plus at 2ul; ok = true; newline })
    else
      let! breaks = (fun () -> line_break input #frame at) in
      block_comment input #frame (next at) (newline || breaks) (minus fuel 1ul)

let rec trivia_from (input:tape) (#frame:slprop) (at:U32.t) (newline:bool) (fuel:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if U32.(at >=^ input.size) then read_ret input #frame ({ at; ok = true; newline })
  else if fuel = 0ul then read_ret input #frame ({ at; ok = false; newline })
  else
    let! ch = (fun () -> peek input #frame at) in
    if G.whitespace ch then
      trivia_from input #frame (next at) (newline || ch = 13uy || ch = 10uy) (minus fuel 1ul)
    else if ch = 226uy then
      let! separator = (fun () -> separator input #frame at) in
      if separator then trivia_from input #frame (plus at 3ul) true (minus fuel 1ul)
      else read_ret input #frame ({ at; ok = true; newline })
    else if ch = 47uy then
      let! follower = (fun () -> peek input #frame (next at)) in
      if follower = 47uy || follower = 42uy then
        let where = plus at 2ul in
        let! r = (fun () -> if follower = 47uy then line_comment input #frame where input.size else block_comment input #frame where false input.size) in
        if r.ok then trivia_from input #frame r.at (newline || r.newline) (minus fuel 1ul)
        else read_ret input #frame (r)
      else read_ret input #frame ({ at; ok = true; newline })
    else read_ret input #frame ({ at; ok = true; newline })

let trivia (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  trivia_from input #frame at false (plus input.size 1ul)

let source_start (input:tape) (#frame:slprop) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! hash = (fun () -> same input #frame 0ul 35uy) in
  let! bang = (fun () -> if hash then same input #frame 1ul 33uy else read_ret input #frame (false)) in
  if bang then (let! anf_value_1 = (fun () -> (line_comment input #frame 2ul input.size)) in read_ret input #frame (anf_value_1.at)) else read_ret input #frame (0ul)

let scan_class (input:tape) (#frame:slprop) (at:U32.t) (cls:G.byte_class) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if U32.(at <=^ input.size) then TmtPulseMemory.scan_class input #frame at (class_code cls) else read_ret input #frame (at)

let rec jsx_name_end (input:tape) (#frame:slprop) (at:U32.t) (fuel:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul then read_ret input #frame (at)
  else
    let! finish = (fun () -> scan_class input #frame at G.Identifier) in
    let! dash = (fun () -> same input #frame finish 45uy) in
    if dash then jsx_name_end input #frame (next finish) (minus fuel 1ul) else read_ret input #frame (finish)

let rec word (input:tape) (#frame:slprop) (at:U32.t) (fuel:U32.t) (value:U64.t) : Tot (stt U64.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul then read_ret input #frame (value)
  else
    let! byte = (fun () -> peek input #frame at) in
    word input #frame (next at) (minus fuel 1ul) (U64.logor (U64.shift_left value 8ul) (Cast.uint8_to_uint64 byte))

let keyword (input:tape) (#frame:slprop) (at:U32.t) (size:U32.t) (expected:U64.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! value = (fun () -> word input #frame at size 0uL) in
  let! following = (fun () -> peek input #frame (plus at size)) in
  read_ret input #frame (value = expected && not (G.identifier_continue following))

// Recognize only raw directives with an unambiguous statement boundary.
let strict_directive (input:tape) (#frame:slprop) (at:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! delimiter = (fun () -> peek input #frame at) in
  if delimiter <> 34uy && delimiter <> 39uy then read_ret input #frame false
  else
    let! first = (fun () -> word input #frame (next at) 8ul 0uL) in
    if first <> 0x7573652073747269uL then read_ret input #frame false
    else
      let! last = (fun () -> word input #frame (plus at 9ul) 2ul 0uL) in
      let! closes = (fun () -> same input #frame (plus at 11ul) delimiter) in
      if last <> 0x6374uL || not closes then read_ret input #frame false
      else
        let! tail = (fun () -> trivia input #frame (plus at 12ul)) in
        let! byte = (fun () -> peek input #frame tail.at) in
        if not tail.ok then read_ret input #frame false
        else if byte = 59uy then read_ret input #frame true
        else if not tail.newline then read_ret input #frame false
        else if byte = 99uy then keyword input #frame tail.at 5ul 0x636f6e7374uL
        else if byte = 108uy then keyword input #frame tail.at 3ul 0x6c6574uL
        else if byte = 118uy then keyword input #frame tail.at 3ul 0x766172uL
        else if byte = 102uy then keyword input #frame tail.at 8ul 0x66756e6374696f6euL
        else read_ret input #frame false

let short_reserved (packed:U64.t) : bool =
  packed = 0x6177616974uL || packed = 0x627265616buL || packed = 0x63617365uL || packed = 0x6361746368uL || packed = 0x636c617373uL ||
  packed = 0x636f6e7374uL || packed = 0x636f6e74696e7565uL || packed = 0x6465627567676572uL || packed = 0x64656661756c74uL || packed = 0x64656c657465uL ||
  packed = 0x646fuL || packed = 0x656c7365uL || packed = 0x656e756duL || packed = 0x6578706f7274uL || packed = 0x657874656e6473uL ||
  packed = 0x66616c7365uL || packed = 0x66696e616c6c79uL || packed = 0x666f72uL || packed = 0x66756e6374696f6euL || packed = 0x6966uL ||
  packed = 0x696d706f7274uL || packed = 0x696euL || packed = 0x6c6574uL || packed = 0x6e6577uL || packed = 0x6e756c6cuL ||
  packed = 0x7061636b616765uL || packed = 0x70726976617465uL || packed = 0x7075626c6963uL || packed = 0x72657475726euL || packed = 0x737461746963uL ||
  packed = 0x7375706572uL || packed = 0x737769746368uL || packed = 0x74686973uL || packed = 0x7468726f77uL || packed = 0x74727565uL ||
  packed = 0x747279uL || packed = 0x747970656f66uL || packed = 0x766172uL || packed = 0x766f6964uL || packed = 0x7768696c65uL ||
  packed = 0x77697468uL || packed = 0x7969656c64uL

let long_reserved (first:U64.t) (rest:U64.t) : bool =
  if first = 0x696d706c656d656euL then rest = 0x7473uL
  else if first = 0x696e7374616e6365uL then rest = 0x6f66uL
  else if first = 0x696e746572666163uL then rest = 0x65uL
  else if first = 0x70726f7465637465uL then rest = 0x64uL
  else false

let name (input:tape) (#frame:slprop) (at:U32.t) (jsx binding:bool) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame at) in
  if not (G.identifier_start first) then read_ret input #frame ({ at; ok = false; newline = false })
  else if jsx then (let! anf_value_1 = (fun () -> jsx_name_end input #frame at input.size) in read_ret input #frame ({ at = anf_value_1; ok = true; newline = false }))
  else
    let! stop = (fun () -> scan_class input #frame at G.Identifier) in
    let width = minus stop at in
    if U32.(width >^ 10ul) then read_ret input #frame ({ at = stop; ok = true; newline = false })
    else
      let wide = U32.(width >^ 8ul) in
      let! head = (fun () -> word input #frame at (if wide then 8ul else width) 0uL) in
      let! rest = (fun () -> if wide then word input #frame (plus at 8ul) (minus width 8ul) 0uL else read_ret input #frame (0uL)) in
      read_ret input #frame (let reserved = if wide then long_reserved head rest else short_reserved head in
      let invalid_binding = binding && (head = 0x6576616cuL || (head = 0x617267756d656e74uL && rest = 0x73uL)) in
      { at = stop; ok = not (reserved || invalid_binding); newline = false })

type names_used = used:U32.t{U32.v used <= U32.v binding_region_width}
type binding_mode =
  | NoLocals
  | LexicalLocals
  | VarLocals

type super_context =
  | NoSuper
  | MethodSuper
  | BaseConstructor
  | DerivedConstructor
  | ClassField

type parser_state = {
  offset:U32.t; count:U32.t; depth:U32.t; status:U32.t; local_names:names_used;
  await_allowed:bool; yield_allowed:bool; jsx_allowed:bool; module_mode:bool; strict_script:bool; in_allowed:bool; for_initializer:bool;
  arrow_defaults_allowed:bool; binding_mode:binding_mode; super_context:super_context;
  private_scope:U8.t; private_count:U8.t
}
type assignment_target =
  | NotAssignable
  | Assignable
  | MemberTarget
  | PrivateTarget
  | BareSuper
  | OptionalChain
  | AssertedTarget
  | ArrayTarget

type jump_context =
  | NoJump
  | BreakOnly
  | LoopJump

let can_assign (target:assignment_target) : bool = target = Assignable || target = MemberTarget || target = PrivateTarget
let can_assign_expression (target:assignment_target) : bool = can_assign target || target = AssertedTarget
type parsed = { parser:parser_state; range:G.span; open_angle:bool; outer_or:bool; right_shift:bool; shortcut:U32.t; target:assignment_target }
type expression_items = { list_end:parser_state; valid_array_target:bool }

let failed (state:parser_state) (error:U32.t) : parser_state =
  if state.status = 0ul then { state with status = error } else state

let record_binding_mode (state:parser_state) (kind:binding_mode) : parser_state =
  if state.binding_mode = NoLocals || state.binding_mode = kind then { state with binding_mode = kind }
  else failed state 1ul

let start_range (pos:U32.t) : G.span = { G.first = pos; G.last = pos }
let empty_range (state:parser_state) : parsed =
  { parser = state; range = start_range state.offset; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }

let consume (input:tape) (#frame:slprop) (state:parser_state) (byte:U8.t) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if state.status <> 0ul then read_ret input #frame (state)
  else
    let! ok = (fun () -> same input #frame state.offset byte) in
    read_ret input #frame (if ok then { state with offset = next state.offset } else failed state 1ul)

let from_cursor (state:parser_state) (read:cursor) : parser_state =
  if state.status <> 0ul then state
  else if read.ok then { state with offset = read.at } else failed state 1ul

let skip (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if state.status <> 0ul then read_ret input #frame (state)
  else
    let! cursor = (fun () -> trivia input #frame state.offset) in
    read_ret input #frame (from_cursor state cursor)

let operator_end (start:U32.t) (op:U32.t) : U32.t =
  plus start (if op = 2ul || op = 4ul then 2ul else 1ul)

let comparison_edit (start op:U32.t) : G.span =
  { G.first = start; G.last = operator_end start op }

fn emit_comparison (input:tape) (state:parser_state) (slot op start:U32.t) (left right:G.span)
  (#before:FStar.Ghost.erased (Seq.seq (option G.candidate)))
  requires A.pts_to_mask input.output before owned ** pure (Seq.length before == U32.v input.capacity)
  returns result:parser_state
  ensures exists* after.
    A.pts_to_mask input.output after owned ** pure (Seq.length after == U32.v input.capacity /\
      (if U32.v slot < Seq.length before then
        result == state /\
        after == Seq.upd before (U32.v slot) (Some (G.make_candidate op (comparison_edit start op) left right))
      else after == before /\ result == failed state 4ul))
{
  if U32.(slot <^ input.capacity) {
    S.save_candidate input.output slot (G.make_candidate op (comparison_edit start op) left right);
    state
  } else {
    failed state 4ul
  }
}

fn emit_comparison_in_workspace (input:tape) (state:parser_state) (slot op start:U32.t) (left right:G.span)
  requires heap input
  returns result:parser_state
  ensures heap input
{
  unfold heap;
  unfold workspace_ready;
  unfold workspace_at;
  let result = emit_comparison input state slot op start left right;
  if U32.(slot <^ input.capacity) {
    Pulse.Lib.Array.pts_to_len input.marks;
    input.marks.(Size.uint32_to_sizet slot) <- 1uy;
    fold workspace_at;
  } else {
    fold workspace_at;
  };
  fold workspace_ready;
  fold heap;
  result
}

let hex_value (ch:U8.t) : U32.t =
  let n = Cast.uint8_to_uint32 ch in
  if G.decimal_digit ch then U32.sub n 48ul
  else if U8.(ch >=^ 97uy && ch <=^ 102uy) then U32.sub n 87ul
  else if U8.(ch >=^ 65uy && ch <=^ 70uy) then U32.sub n 55ul
  else 16ul

let simple_escape (input:tape) (#frame:slprop) (at:U32.t) (template:bool) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! escape = (fun () -> peek input #frame (next at)) in
  let! following = (fun () -> peek input #frame (plus at 2ul)) in
  read_ret input #frame (escape = 92uy || escape = 34uy || escape = 39uy ||
  escape = 110uy || escape = 114uy || escape = 116uy || escape = 98uy ||
  escape = 102uy || escape = 118uy || (escape = 48uy && not (G.decimal_digit following)) ||
  (template && (escape = 36uy || escape = 96uy)))

let rec fixed_hex (input:tape) (#frame:slprop) (at digits:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v digits) =
  if digits = 0ul then read_ret input #frame ({ at; ok = true; newline = false })
  else
    let! anf_value_1 = (fun () -> peek input #frame at) in
    let value = hex_value anf_value_1 in
    if value = 16ul then read_ret input #frame ({ at; ok = false; newline = false })
    else fixed_hex input #frame (next at) (minus digits 1ul)

let rec unicode_escape (input:tape) (#frame:slprop) (at value fuel:U32.t) (seen:bool) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(value >^ 0x10fffful) then read_ret input #frame ({ at; ok = false; newline = false })
  else (let! anf_value_1 = (fun () -> same input #frame at 125uy) in if anf_value_1 then read_ret input #frame ({ at = next at; ok = seen; newline = false })
  else
    let! anf_value_2 = (fun () -> peek input #frame at) in
    let digit = hex_value anf_value_2 in
    if digit = 16ul then read_ret input #frame ({ at; ok = false; newline = false })
    else unicode_escape input #frame (next at) (U32.add (U32.mul value 16ul) digit) (minus fuel 1ul) true)

let escape_end (input:tape) (#frame:slprop) (at:U32.t) (template extended:bool) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> simple_escape input #frame at template) in if anf_value_1 then read_ret input #frame ({ at = plus at 2ul; ok = true; newline = false })
  else if not extended then read_ret input #frame ({ at; ok = false; newline = false })
  else
    let start = next at in
    let! escape = (fun () -> peek input #frame start) in
    let after = next start in
    if escape = 120uy then fixed_hex input #frame after 2ul
    else if escape = 117uy then
      (let! anf_value_2 = (fun () -> same input #frame after 123uy) in if anf_value_2 then unicode_escape input #frame (next after) 0ul input.size false
      else fixed_hex input #frame after 4ul)
    else
      let! breaks = (fun () -> line_break input #frame start) in
      if not breaks then read_ret input #frame ({ at; ok = false; newline = false })
      else
        let! width = (fun () -> if escape = 13uy then ((let! anf_value_3 = (fun () -> same input #frame after 10uy) in if anf_value_3 then read_ret input #frame (2ul) else read_ret input #frame (1ul)))
          else read_ret input #frame (if escape = 10uy then 1ul else 3ul)) in
        read_ret input #frame ({ at = plus start width; ok = true; newline = false }))

let rec string_end (input:tape) (#frame:slprop) (at:U32.t) (delimiter:U8.t) (fuel:U32.t) (extended:bool)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ input.size) then read_ret input #frame ({ at; ok = false; newline = false })
  else
    let! byte = (fun () -> peek input #frame at) in
    if byte = delimiter then read_ret input #frame ({ at = next at; ok = true; newline = false })
    else
      let! breaks = (fun () -> line_break input #frame at) in
      if breaks then read_ret input #frame ({ at; ok = false; newline = false })
      else if byte = 92uy then
        let! escape = (fun () -> escape_end input #frame at false extended) in
        if escape.ok then string_end input #frame escape.at delimiter (minus fuel 1ul) extended
        else read_ret input #frame (escape)
      else string_end input #frame (next at) delimiter (minus fuel 1ul) extended

let regex_printable (ch:U8.t) : bool = U8.(ch >=^ 32uy && ch <=^ 126uy)

let no_character : U32.t = 65536ul

type regex_unit = { unit_end:U32.t; unit_ok:bool; character:U32.t; repeatable:bool }

let regex_escape (input:tape) (#frame:slprop) (at:U32.t) (in_class:bool) : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! escape = (fun () -> peek input #frame (next at)) in
  let finish = plus at 2ul in
  let! nul = (fun () -> if escape = 48uy then
    let! following = (fun () -> peek input #frame finish) in read_ret input #frame (not (G.decimal_digit following))
    else read_ret input #frame (false)) in
  let punctuation =
    escape = 47uy || escape = 92uy || escape = 46uy || escape = 36uy || escape = 94uy ||
    escape = 43uy || escape = 42uy || escape = 63uy || escape = 124uy ||
    escape = 91uy || escape = 93uy || escape = 123uy || escape = 125uy ||
    escape = 40uy || escape = 41uy || (in_class && escape = 45uy) in
  let character =
    if punctuation then Cast.uint8_to_uint32 escape
    else if escape = 110uy then 10ul
    else if escape = 114uy then 13ul
    else if escape = 116uy then 9ul
    else if escape = 102uy then 12ul
    else if escape = 118uy then 11ul
    else if in_class && escape = 98uy then 8ul
    else if nul then 0ul
    else no_character in
  if escape = 120uy then
    let! anf_value_1 = (fun () -> peek input #frame finish) in
    let high = hex_value anf_value_1 in
    let! anf_value_2 = (fun () -> peek input #frame (next finish)) in
    let low = hex_value anf_value_2 in
    read_ret input #frame (if high = 16ul || low = 16ul then
      { unit_end = at; unit_ok = false; character = no_character; repeatable = false }
    else { unit_end = plus at 4ul; unit_ok = true;
      character = U32.add (U32.mul high 16ul) low; repeatable = true })
  else if escape = 117uy then
    let! anf_value_3 = (fun () -> peek input #frame finish) in
    let a = hex_value anf_value_3 in
    let! anf_value_4 = (fun () -> peek input #frame (plus finish 1ul)) in
    let b = hex_value anf_value_4 in
    let! anf_value_5 = (fun () -> peek input #frame (plus finish 2ul)) in
    let c = hex_value anf_value_5 in
    let! anf_value_6 = (fun () -> peek input #frame (plus finish 3ul)) in
    let d = hex_value anf_value_6 in
    read_ret input #frame (let value = U32.(logor (logor (shift_left a 12ul) (shift_left b 8ul)) (logor (shift_left c 4ul) d)) in
    let scalar = U32.(value <^ 55296ul || value >^ 57343ul) in
    let valid = a <> 16ul && b <> 16ul && c <> 16ul && d <> 16ul && scalar in
    { unit_end = plus at 6ul; unit_ok = valid;
      character = if valid then value else no_character; repeatable = valid })
  else
    read_ret input #frame (let group = escape = 115uy || escape = 83uy || escape = 100uy || escape = 68uy || escape = 119uy || escape = 87uy in
    let boundary = not in_class && (escape = 98uy || escape = 66uy) in
    { unit_end = finish; unit_ok = character <> no_character || group || boundary;
      character; repeatable = not boundary })

let utf8_tail (ch:U8.t) : bool = U8.(ch >=^ 128uy && ch <^ 192uy)

let utf8_bits (byte:U8.t) (mask:U32.t) : U32.t = U32.logand (Cast.uint8_to_uint32 byte) mask

let regex_bmp_unit (input:tape) (#frame:slprop) (at:U32.t) (first:U8.t)
  : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let invalid = { unit_end = at; unit_ok = false; character = no_character; repeatable = false } in
  if U8.(first <^ 194uy || first >=^ 240uy) then read_ret input #frame invalid
  else
    let! second = (fun () -> peek input #frame (next at)) in
    if not (utf8_tail second) then read_ret input #frame invalid
    else if U8.(first <^ 224uy) then
      let value = U32.logor (U32.shift_left (utf8_bits first 31ul) 6ul) (utf8_bits second 63ul) in
      read_ret input #frame { unit_end = plus at 2ul; unit_ok = true; character = value; repeatable = true }
    else
      let! third = (fun () -> peek input #frame (plus at 2ul)) in
      let value = U32.logor (U32.shift_left (utf8_bits first 15ul) 12ul)
        (U32.logor (U32.shift_left (utf8_bits second 63ul) 6ul) (utf8_bits third 63ul)) in
      if utf8_tail third && U32.(value >=^ 2048ul && (value <^ 55296ul || value >^ 57343ul)) &&
        value <> 8232ul && value <> 8233ul then
        read_ret input #frame { unit_end = plus at 3ul; unit_ok = true; character = value; repeatable = true }
      else read_ret input #frame invalid

let regex_class_unit (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame at) in
  if byte = 92uy then regex_escape input #frame at true
  else if not (U8.lt byte 128uy) then regex_bmp_unit input #frame at byte
  else read_ret input #frame ({ unit_end = next at; unit_ok = regex_printable byte && byte <> 93uy;
    character = Cast.uint8_to_uint32 byte; repeatable = true })

let rec regex_class (input:tape) (#frame:slprop) (at fuel:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul then read_ret input #frame ({ at; ok = false; newline = false })
  else (let! anf_value_1 = (fun () -> same input #frame at 93uy) in if anf_value_1 then read_ret input #frame ({ at = next at; ok = true; newline = false })
  else
    let! lhs = (fun () -> regex_class_unit input #frame at) in
    if not lhs.unit_ok then read_ret input #frame ({ at; ok = false; newline = false })
    else
      let! dash = (fun () -> same input #frame lhs.unit_end 45uy) in
      let! close = (fun () -> same input #frame (next lhs.unit_end) 93uy) in
      if dash && not close then
        let! rhs = (fun () -> regex_class_unit input #frame (next lhs.unit_end)) in
        if rhs.unit_ok && U32.(lhs.character <=^ rhs.character && rhs.character <^ no_character) then
          regex_class input #frame rhs.unit_end (minus fuel 1ul)
        else read_ret input #frame ({ at; ok = false; newline = false })
      else regex_class input #frame lhs.unit_end (minus fuel 1ul))

type regex_count = { count_end:U32.t; count_value:U32.t; count_ok:bool }

let rec regex_decimal (input:tape) (#frame:slprop) (at value remaining:U32.t)
  : Tot (stt regex_count (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! byte = (fun () -> peek input #frame at) in
  if not (G.decimal_digit byte) then read_ret input #frame ({ count_end = at; count_value = value; count_ok = remaining <> 6ul })
  else if remaining = 0ul || U32.(value >^ 99999ul) then
    read_ret input #frame ({ count_end = at; count_value = value; count_ok = false })
  else
    let digit = U32.sub (Cast.uint8_to_uint32 byte) 48ul in
    regex_decimal input #frame (next at) (U32.add (U32.mul value 10ul) digit) (minus remaining 1ul)

let regex_counted (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! lower = (fun () -> regex_decimal input #frame (next at) 0ul 6ul) in
  let! comma = (fun () -> same input #frame lower.count_end 44uy) in
  let! upper =
    (fun () -> if not comma then read_ret input #frame (lower)
    else (let! anf_value_1 = (fun () -> same input #frame (next lower.count_end) 125uy) in if anf_value_1 then read_ret input #frame ({ lower with count_end = next lower.count_end })
    else regex_decimal input #frame (next lower.count_end) 0ul 6ul)) in
  let! complete = (fun () -> same input #frame upper.count_end 125uy) in
  read_ret input #frame ({ at = next upper.count_end;
    ok = lower.count_ok && upper.count_ok && complete && U32.(lower.count_value <=^ upper.count_value);
    newline = false })

let regex_flag_bit (byte:U8.t) : U32.t =
  if byte = 100uy then 1ul
  else if byte = 103uy then 2ul
  else if byte = 105uy then 4ul
  else if byte = 109uy then 8ul
  else if byte = 115uy then 16ul
  else if byte = 117uy then 32ul
  else if byte = 121uy then 64ul
  else 0ul

let rec regex_flags (input:tape) (#frame:slprop) (at seen fuel:U32.t) (legacy:bool) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let! byte = (fun () -> peek input #frame at) in
  let bit = regex_flag_bit byte in
  if bit = 0ul then read_ret input #frame ({ at; ok = not (G.identifier_continue byte || byte = 92uy); newline = false })
  else if fuel = 0ul || U32.logand bit seen <> 0ul || (legacy && bit = 32ul) then read_ret input #frame ({ at; ok = false; newline = false })
  else regex_flags input #frame (next at) (U32.logor bit seen) (minus fuel 1ul) legacy

type regex_captures = { names:U64.t; count:U32.t; legacy:bool }
type regex_result = { ending:cursor; captures:regex_captures }
type regex_group_result = { pattern:regex_result; repeatable_group:bool }

let regex_result_at (at:U32.t) (ok:bool) (captures:regex_captures) : regex_result =
  { ending = { at; ok; newline = false }; captures }

let rec capture_hash (input:tape) (#frame:slprop) (at remaining value:U32.t)
  : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  if remaining = 0ul then read_ret input #frame (value)
  else
    let! byte = (fun () -> peek input #frame at) in
    let folded = U32.mul_mod (U32.logxor value (Cast.uint8_to_uint32 byte)) 16777619ul in
    capture_hash input #frame (next at) (minus remaining 1ul) folded

let rec regex_pattern (input:tape) (#frame:slprop) (at depth fuel:U32.t) (nested can_repeat:bool) (captures:regex_captures)
  : Tot (stt regex_result (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v depth; 1; U32.v fuel]) =
  if fuel = 0ul || U32.(at >=^ input.size) then read_ret input #frame (regex_result_at at false captures)
  else
    let! byte = (fun () -> peek input #frame at) in
    let rest = minus fuel 1ul in
    if byte = 47uy && not nested then
      let! ending = (fun () -> regex_flags input #frame (next at) 0ul 7ul captures.legacy) in read_ret input #frame ({ ending; captures })
    else if byte = 41uy && nested then read_ret input #frame (regex_result_at (next at) true captures)
    else if byte = 40uy then
      let! group = (fun () -> regex_group input #frame at depth rest captures) in
      let parsed = group.pattern in
      if not parsed.ending.ok then read_ret input #frame (parsed)
      else regex_pattern input #frame parsed.ending.at depth rest nested group.repeatable_group parsed.captures
    else if byte = 91uy then
      let! negated = (fun () -> same input #frame (next at) 94uy) in
      let! class_ = (fun () -> regex_class input #frame (plus at (if negated then 2ul else 1ul)) rest) in
      if not class_.ok then read_ret input #frame ({ ending = class_; captures })
      else regex_pattern input #frame class_.at depth rest nested true captures
    else if byte = 92uy then
      let! first = (fun () -> peek input #frame (next at)) in
      if U8.(first >=^ 49uy && first <=^ 57uy) then
        let! index = (fun () -> regex_decimal input #frame (next at) 0ul 6ul) in
        if index.count_ok && U32.(index.count_value <=^ captures.count) then
          regex_pattern input #frame index.count_end depth rest nested true captures
        else read_ret input #frame (regex_result_at at false captures)
      else if first = 58uy then
        regex_pattern input #frame (plus at 2ul) depth rest nested true { captures with legacy = true }
      else
        let! escaped = (fun () -> regex_escape input #frame at false) in
        if not escaped.unit_ok then read_ret input #frame (regex_result_at at false captures)
        else regex_pattern input #frame escaped.unit_end depth rest nested escaped.repeatable captures
    else if byte = 124uy || byte = 94uy || byte = 36uy then
      regex_pattern input #frame (next at) depth rest nested false captures
    else if byte = 43uy || byte = 42uy || byte = 63uy || byte = 123uy then
      let! literal_brace = (fun () -> if byte = 123uy then
        let! first = (fun () -> peek input #frame (next at)) in
        read_ret input #frame (not (G.decimal_digit first))
        else read_ret input #frame false) in
      if literal_brace then regex_pattern input #frame (next at) depth rest nested true { captures with legacy = true }
      else if not can_repeat then read_ret input #frame (regex_result_at at false captures)
      else
        let! quantifier = (fun () -> if byte = 123uy then regex_counted input #frame at
          else read_ret input #frame ({ at = next at; ok = true; newline = false })) in
        if not quantifier.ok then read_ret input #frame ({ ending = quantifier; captures })
        else
          let! lazy_ = (fun () -> same input #frame quantifier.at 63uy) in
          let after = if lazy_ then next quantifier.at else quantifier.at in
          regex_pattern input #frame after depth rest nested false captures
    else if regex_printable byte && byte <> 47uy && byte <> 41uy && byte <> 93uy then
      let captures = if byte = 125uy then { captures with legacy = true } else captures in
      regex_pattern input #frame (next at) depth rest nested true captures
    else if not (U8.lt byte 128uy) then
      let! atom = (fun () -> regex_bmp_unit input #frame at byte) in
      if atom.unit_ok then regex_pattern input #frame atom.unit_end depth rest nested true captures
      else read_ret input #frame (regex_result_at at false captures)
    else read_ret input #frame (regex_result_at at false captures)
and regex_group (input:tape) (#frame:slprop) (at depth fuel:U32.t) (captures:regex_captures)
  : Tot (stt regex_group_result (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v depth; 0; U32.v fuel]) =
  // Only a group descent uses a native stack frame. The flat scanner is tail-recursive.
  let! question = (fun () -> same input #frame (next at) 63uy) in
  let! marker = (fun () -> peek input #frame (plus at 2ul)) in
  let prefix = plus at 3ul in
  let names = captures.names in
  let! start, names, repeatable_group =
    (fun () -> if not question then read_ret input #frame (next at, names, true)
    else if marker = 58uy then read_ret input #frame (prefix, names, true)
    else if marker = 61uy || marker = 33uy then read_ret input #frame (prefix, names, false)
    else if marker = 60uy then
      let! first = (fun () -> peek input #frame prefix) in
      if first = 61uy || first = 33uy then read_ret input #frame (next prefix, names, false)
      else if not (G.identifier_start first) then read_ret input #frame (at, names, false)
      else
        let! limit = (fun () -> scan_class input #frame prefix G.Identifier) in
        let! closed = (fun () -> same input #frame limit 62uy) in
        // Equal names set both positions. If both are occupied, leave the decision to compatibility parsing.
        let! hash = (fun () -> capture_hash input #frame prefix (minus limit prefix) 2166136261ul) in
        read_ret input #frame (let low = U64.shift_left 1uL (U32.rem hash 32ul) in
        let high_index = U32.add 32ul (U32.rem (U32.shift_right hash 16ul) 32ul) in
        let high = U64.shift_left 1uL high_index in
        let bits = U64.logor low high in
        if closed && U64.logand names bits <> bits then next limit, U64.logor names bits, true
        else at, names, false)
    else read_ret input #frame (at, names, false)) in
  let capturing = not question || (marker = 60uy && repeatable_group) in
  let! pattern =
    (fun () -> if start = at || depth = 0ul || U32.(captures.count >=^ input.size) then read_ret input #frame (regex_result_at at false captures)
    else
      let count = if capturing then U32.add captures.count 1ul else captures.count in
      regex_pattern input #frame start (minus depth 1ul) fuel true false { captures with names; count }) in
  read_ret input #frame ({ pattern; repeatable_group })

let regex_end (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! parsed = (fun () -> regex_pattern input #frame at 32ul input.size false false { names = 0uL; count = 0ul; legacy = false }) in
  read_ret input #frame (parsed.ending)

type precedence = p:U32.t{1 <= U32.v p /\ U32.v p <= 11}
type binary_operator = { strength:precedence; width:U32.t; boundary:U32.t; nullish:bool }

let shift_width (input:tape) (#frame:slprop) (at:U32.t) (byte:U8.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! third = (fun () -> peek input #frame (plus at 2ul)) in
  read_ret input #frame (if byte = 62uy && third = 62uy then 3ul else 2ul)

let operator (input:tape) (#frame:slprop) (at:U32.t) (in_allowed:bool) : Tot (stt binary_operator (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame at) in
  let! follower = (fun () -> peek input #frame (next at)) in
  let none = { strength = 1ul; width = 0ul; boundary = 0ul; nullish = false } in
  if byte = 60uy || byte = 62uy then
    if byte = follower then
      let! width = (fun () -> shift_width input #frame at byte) in
      (let! anf_value_1 = (fun () -> same input #frame (plus at width) 61uy) in if anf_value_1 then read_ret input #frame (none)
      else read_ret input #frame ({ strength = 8ul; width; boundary = 0ul; nullish = false }))
    else
      let! boundary = (fun () -> boundary input #frame at) in
      read_ret input #frame ({ strength = 7ul; width = (if follower = 61uy then 2ul else 1ul); boundary; nullish = false })
  else if (byte = 61uy || byte = 33uy) && follower = 61uy then
    let! triple = (fun () -> same input #frame (plus at 2ul) 61uy) in
    read_ret input #frame ({ strength = 6ul; width = (if triple then 3ul else 2ul); boundary = 0ul; nullish = false })
  else if (byte = 63uy || byte = 38uy || byte = 124uy) && follower = byte then
    let! assignment = (fun () -> same input #frame (plus at 2ul) 61uy) in
    read_ret input #frame (if assignment then none
    else { strength = (if byte = 38uy then 2ul else 1ul); width = 2ul; boundary = 0ul; nullish = byte = 63uy })
  else if byte = 105uy && follower = 110uy then
    (let! anf_value_2 = (fun () -> keyword input #frame (plus at 2ul) 8ul 0x7374616e63656f66uL) in if anf_value_2 then
      read_ret input #frame ({ strength = 7ul; width = 10ul; boundary = 0ul; nullish = false })
    else if in_allowed then
      (let! anf_value_3 = (fun () -> keyword input #frame at 2ul 0x696euL) in if anf_value_3 then
        read_ret input #frame ({ strength = 7ul; width = 2ul; boundary = 0ul; nullish = false })
      else read_ret input #frame (none))
    else read_ret input #frame (none))
  else if byte = 42uy && follower = 42uy then
    (let! anf_value_4 = (fun () -> same input #frame (plus at 2ul) 61uy) in if anf_value_4 then read_ret input #frame (none)
    else read_ret input #frame ({ strength = 11ul; width = 2ul; boundary = 0ul; nullish = false }))
  else read_ret input #frame (if follower = 61uy then none
  else if byte = 124uy then { strength = 3ul; width = 1ul; boundary = 0ul; nullish = false }
  else if byte = 38uy then { strength = 5ul; width = 1ul; boundary = 0ul; nullish = false }
  else if byte = 94uy then { strength = 4ul; width = 1ul; boundary = 0ul; nullish = false }
  else if (byte = 43uy || byte = 45uy) && follower <> byte then { strength = 9ul; width = 1ul; boundary = 0ul; nullish = false }
  else if (byte = 42uy && follower <> byte) || byte = 47uy || byte = 37uy then
    { strength = 10ul; width = 1ul; boundary = 0ul; nullish = false }
  else none)

let unary_width (input:tape) (#frame:slprop) (at:U32.t) (byte:U8.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if byte = 43uy || byte = 45uy then
    let! doubled = (fun () -> same input #frame (next at) byte) in read_ret input #frame (if doubled then 0ul else 1ul)
  else if byte = 33uy || byte = 126uy then read_ret input #frame (1ul)
  else if byte = 116uy then
    (let! anf_value_1 = (fun () -> keyword input #frame at 6ul 0x747970656f66uL) in if anf_value_1 then read_ret input #frame (6ul) else read_ret input #frame (0ul))
  else if byte = 118uy then
    (let! anf_value_2 = (fun () -> keyword input #frame at 4ul 0x766f6964uL) in if anf_value_2 then read_ret input #frame (4ul) else read_ret input #frame (0ul))
  else read_ret input #frame (0ul)

type names_base = base:U32.t{base = 0ul \/ base = binding_region_width \/ base = export_region_base}
type named_state = { state:parser_state; used:names_used }

let rec same_bytes (input:tape) (#frame:slprop) (left right length:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v length) =
  if length = 0ul then read_ret input #frame (true)
  else
    let! l = (fun () -> peek input #frame left) in
    let! r = (fun () -> peek input #frame right) in
    if l = r then same_bytes input #frame (next left) (next right) (minus length 1ul) else read_ret input #frame (false)

let is_function_binding (namespace:binding_namespace) : bool =
  namespace = FunctionSignature || namespace = FunctionImplementation

let names_overlap (left right:binding_namespace) : bool =
  if is_function_binding left && is_function_binding right then
    left = FunctionImplementation && right = FunctionImplementation
  else
    let left = if is_function_binding left then ValueName else left in
    let right = if is_function_binding right then ValueName else right in
    left = BothNames || right = BothNames || left = right

let rec name_seen (input:tape) (base:names_base) (floor used:names_used) (pos len:U32.t) (namespace:binding_namespace)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U32.v used) =
  if U32.(used <=^ floor) then ret input (false)
  else
    let previous = U32.sub used 1ul in
    let! saved = (fun () -> get_binding input (U32.add base previous)) in
    let! equal = (fun () -> if len = minus saved.span.G.last saved.span.G.first && names_overlap namespace saved.namespace then
      same_bytes input pos saved.span.G.first len else ret input (false)) in
    if equal then ret input (true) else name_seen input base floor previous pos len namespace

let bind_in_namespace (input:tape) (st:parser_state) (base:names_base) (floor used:names_used)
  (pos:U32.t) (namespace:binding_namespace)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! end_name = (fun () -> name input pos false true) in
  let st = from_cursor st end_name in
  let length = minus st.offset pos in
  if st.status <> 0ul || used = binding_region_width || U32.(length >^ 256ul) then ret input ({ state = failed st 1ul; used })
  else (let! anf_value_1 = (fun () -> name_seen input base floor used pos length namespace) in if anf_value_1 then
    ret input (let status = if base = 0ul && namespace = ValueName then 5ul else 1ul in
    { state = failed st status; used })
  else (let! _ = (fun () -> set_binding input (U32.add base used) { span = { G.first = pos; G.last = st.offset }; namespace; owner = 0uy }) in
    ret input ({ state = st; used = U32.add used 1ul })))

let bind_since (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) = bind_in_namespace input st base floor used pos BothNames

let bind_pattern_name (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let namespace = if base = 0ul then ValueName else BothNames in
  bind_in_namespace input st base floor used pos namespace

let bind_at (input:tape) (st:parser_state) (base:names_base) (used:names_used) (pos:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) = bind_since input st base 0ul used pos

let private_identifier (input:tape) (#frame:slprop) (start:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let at = next start in
  let! first = (fun () -> peek input #frame at) in
  if G.identifier_start first then
    let! stop = (fun () -> scan_class input #frame at G.Identifier) in
    read_ret input #frame { at = stop; ok = true; newline = false }
  else read_ret input #frame { at = start; ok = false; newline = false }

let private_slot (index:U8.t{U8.v index < 255}) : at:U32.t{U32.v at < U32.v binding_capacity} =
  U32.add private_region_base (Cast.uint8_to_uint32 index)

let record_private (input:tape) (st:parser_state) (span:G.span) (namespace:binding_namespace)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if st.status <> 0ul then ret input st
  else if st.private_count = 255uy || (namespace <> PrivateScope && st.private_scope = 0uy) then ret input (failed st 1ul)
  else
    let! _ = (fun () -> set_binding input (private_slot st.private_count) { span; namespace; owner = st.private_scope }) in
    let private_count = U8.add st.private_count 1uy in
    ret input { st with private_count; private_scope = if namespace = PrivateScope then private_count else st.private_scope }

let rec has_private_declaration (input:tape) (span:G.span) (owner count:U8.t)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U8.v count) =
  if U8.(count <=^ owner) then ret input false
  else
    let index = U8.sub count 1uy in
    let! entry = (fun () -> get_binding input (private_slot index)) in
    let length = minus span.G.last span.G.first in
    let! equal = (fun () -> if entry.namespace = PrivateDeclaration && entry.owner = owner &&
      length = minus entry.span.G.last entry.span.G.first then
      same_bytes input span.G.first entry.span.G.first length else ret input false) in
    if equal then ret input true else has_private_declaration input span owner index

let rec private_visible (input:tape) (span:G.span) (owner limit:U8.t)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U8.v owner) =
  if owner = 0uy || U8.(owner >^ limit) then ret input false
  else
    let! scope = (fun () -> get_binding input (private_slot (U8.sub owner 1uy))) in
    if scope.namespace <> PrivateScope || U8.(scope.owner >=^ owner) then ret input false
    else
      let! declared = (fun () -> has_private_declaration input span owner limit) in
      if declared then ret input true else private_visible input span scope.owner limit

let rec valid_private_log (input:tape) (limit count:U8.t)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U8.v count) =
  if count = 0uy then ret input true
  else
    let index = U8.sub count 1uy in
    let! entry = (fun () -> get_binding input (private_slot index)) in
    if U8.(entry.owner >^ index) then ret input false
    else
      let! valid = (fun () -> if entry.namespace = PrivateScope then ret input true
        else if entry.owner = 0uy then ret input false
        else if entry.namespace = PrivateReference then private_visible input entry.span entry.owner limit
        else if entry.namespace = PrivateDeclaration then
          let! scope = (fun () -> get_binding input (private_slot (U8.sub entry.owner 1uy))) in
          let! duplicate = (fun () -> has_private_declaration input entry.span entry.owner index) in
          ret input (scope.namespace = PrivateScope && not duplicate)
        else ret input false) in
      if valid then valid_private_log input limit index else ret input false

let type_operator (packed:U64.t) : bool =
  packed = 0x6b65796f66uL || packed = 0x696e666572uL ||
  packed = 0x726561646f6e6c79uL || packed = 0x756e69717565uL ||
  packed = 0x61737365727473uL

let builtin_type (packed:U64.t) : bool =
  packed = 0x6e756d626572uL || packed = 0x737472696e67uL ||
  packed = 0x626f6f6c65616euL || packed = 0x626967696e74uL ||
  packed = 0x6f626a656374uL || packed = 0x73796d626f6cuL ||
  packed = 0x756e6b6e6f776euL || packed = 0x616e79uL ||
  packed = 0x6e65766572uL || packed = 0x766f6964uL ||
  packed = 0x6e756c6cuL || packed = 0x74727565uL || packed = 0x66616c7365uL

let type_name (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! width =
    (fun () -> (let! anf_value_1 = (fun () -> keyword input #frame state.offset 4ul 0x766f6964uL) in if anf_value_1 then read_ret input #frame (4ul)
    else (let! anf_value_2 = (fun () -> keyword input #frame state.offset 4ul 0x6e756c6cuL) in if anf_value_2 then read_ret input #frame (4ul)
    else (let! anf_value_3 = (fun () -> keyword input #frame state.offset 4ul 0x74727565uL) in if anf_value_3 then read_ret input #frame (4ul)
    else (let! anf_value_4 = (fun () -> keyword input #frame state.offset 5ul 0x66616c7365uL) in if anf_value_4 then read_ret input #frame (5ul)
    else (let! anf_value_5 = (fun () -> keyword input #frame state.offset 5ul 0x636f6e7374uL) in if anf_value_5 then read_ret input #frame (5ul)
    else read_ret input #frame (0ul))))))) in
  if width <> 0ul then read_ret input #frame ({ at = plus state.offset width; ok = true; newline = false })
  else name input #frame state.offset false false

let packed_type (input:tape) (#frame:slprop) (start finish:U32.t) : Tot (stt U64.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let length = minus finish start in
  if U32.(length <=^ 8ul) then word input #frame start length 0uL else read_ret input #frame (0uL)

let undefined_type (input:tape) (#frame:slprop) (start finish:U32.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if minus finish start <> 9ul then read_ret input #frame (false)
  else
    let! prefix = (fun () -> word input #frame start 8ul 0uL) in
    let! last = (fun () -> peek input #frame (plus start 8ul)) in
    read_ret input #frame (prefix = 0x756e646566696e65uL && last = 100uy)

let rec qualified_name (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let! after = (fun () -> trivia input #frame state.offset) in
  let st = from_cursor state after in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 46uy) in if anf_value_1 then
    if after.newline || fuel = 0ul then read_ret input #frame (failed st 1ul)
    else
      let! property = (fun () -> skip input #frame { st with offset = next st.offset }) in
      let! byte = (fun () -> peek input #frame property.offset) in
      if property.status <> 0ul || not (G.identifier_start byte) then read_ret input #frame (failed property 1ul)
      else
        let! end_at = (fun () -> scan_class input #frame property.offset G.Identifier) in
        qualified_name input #frame { property with offset = end_at } (minus fuel 1ul)
  else read_ret input #frame (state))

let property_name (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame state.offset) in
  if byte = 34uy || byte = 39uy then string_end input #frame (next state.offset) byte input.size false
  else if G.identifier_start byte then
    (let! anf_value_1 = (fun () -> scan_class input #frame state.offset G.Identifier) in read_ret input #frame ({ at = anf_value_1; ok = true; newline = false }))
  else read_ret input #frame ({ at = state.offset; ok = false; newline = false })

let radix_digit (radix:U32.t) (ch:U8.t) : bool =
  if radix = 2ul then ch = 48uy || ch = 49uy
  else if radix = 8ul then U8.(ch >=^ 48uy && ch <=^ 55uy)
  else G.decimal_digit ch || (radix = 16ul &&
    (U8.(ch >=^ 65uy && ch <=^ 70uy) || U8.(ch >=^ 97uy && ch <=^ 102uy)))

let rec radix_end (input:tape) (#frame:slprop) (at radix fuel:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul then read_ret input #frame (at)
  else
    let! byte = (fun () -> peek input #frame at) in
    if radix_digit radix byte then radix_end input #frame (next at) radix (minus fuel 1ul)
    else read_ret input #frame (at)

let rec number_digits (input:tape) (#frame:slprop) (at radix fuel:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let! first = (fun () -> peek input #frame at) in
  if fuel = 0ul || not (radix_digit radix first) then read_ret input #frame ({ at; ok = false; newline = false })
  else
    let! stop = (fun () -> if radix = 10ul then scan_class input #frame at G.DecimalDigits else radix_end input #frame at radix input.size) in
    let! separator = (fun () -> same input #frame stop 95uy) in
    if separator then number_digits input #frame (next stop) radix (minus fuel 1ul)
    else read_ret input #frame ({ at = stop; ok = true; newline = false })

let number_suffix (input:tape) (#frame:slprop) (digits:cursor) (bigint:bool) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if not digits.ok then read_ret input #frame (digits)
  else
    let! byte = (fun () -> peek input #frame digits.at) in
    let finish = if bigint && byte = 110uy then next digits.at else digits.at in
    let! following = (fun () -> peek input #frame finish) in
    read_ret input #frame ({ at = finish; ok = not (G.identifier_continue following || following = 92uy); newline = false })

let number_end (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame at) in
  let! second = (fun () -> peek input #frame (next at)) in
  let radix =
    if first <> 48uy then 10ul
    else if second = 120uy || second = 88uy then 16ul
    else if second = 111uy || second = 79uy then 8ul
    else if second = 98uy || second = 66uy then 2ul
    else 10ul in
  if radix <> 10ul then (let! anf_value_1 = (fun () -> (number_digits input #frame (plus at 2ul) radix input.size)) in number_suffix input #frame anf_value_1 true)
  else if first = 48uy && (G.decimal_digit second || second = 95uy) then
    read_ret input #frame ({ at; ok = false; newline = false })
  else
    let! integer = (fun () -> if first = 46uy then read_ret input #frame ({ at; ok = true; newline = false })
      else number_digits input #frame at 10ul input.size) in
    let! dot = (fun () -> same input #frame integer.at 46uy) in
    let! fraction =
      (fun () -> if not integer.ok || not dot then read_ret input #frame (integer)
      else
        let start = next integer.at in
        let! next_byte = (fun () -> peek input #frame start) in
        if G.decimal_digit next_byte || first = 46uy then number_digits input #frame start 10ul input.size
        else read_ret input #frame ({ integer with at = start })) in
    let! marker = (fun () -> peek input #frame fraction.at) in
    let exponent = marker = 101uy || marker = 69uy in
    let! value =
      (fun () -> if not fraction.ok || not exponent then read_ret input #frame (fraction)
      else
        let! sign = (fun () -> peek input #frame (next fraction.at)) in
        let start = plus fraction.at (if sign = 43uy || sign = 45uy then 2ul else 1ul) in
        number_digits input #frame start 10ul input.size) in
    number_suffix input #frame value (not dot && not exponent)

let import_type (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! open_ = (fun () -> skip input #frame { state with offset = plus state.offset 6ul }) in
  let! module_ = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame open_ 40uy)) in skip input #frame anf_value_1)) in
  let! delimiter = (fun () -> peek input #frame module_.offset) in
  if delimiter <> 34uy && delimiter <> 39uy then read_ret input #frame (failed module_ 1ul)
  else
    let! text = (fun () -> (let! anf_value_2 = (fun () -> (string_end input #frame (next module_.offset) delimiter input.size false)) in read_ret input #frame (from_cursor module_ anf_value_2))) in
    let! close = (fun () -> (let! anf_value_3 = (fun () -> (skip input #frame text)) in consume input #frame anf_value_3 41uy)) in
    qualified_name input #frame close 64ul

type type_query_target = { query_end:parser_state; is_import:bool }

let type_query (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt type_query_target (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! target = (fun () -> skip input #frame { state with offset = plus state.offset 6ul }) in
  (let! anf_value_1 = (fun () -> keyword input #frame target.offset 6ul 0x696d706f7274uL) in if anf_value_1 then
    (let! anf_value_2 = (fun () -> import_type input #frame target) in read_ret input #frame ({ query_end = anf_value_2; is_import = true }))
  else
    let! named = (fun () -> (let! anf_value_3 = (fun () -> (name input #frame target.offset false false)) in read_ret input #frame (from_cursor target anf_value_3))) in
    (let! anf_value_4 = (fun () -> qualified_name input #frame named 64ul) in read_ret input #frame ({ query_end = anf_value_4; is_import = false })))

let spread_at (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> same input #frame at 46uy) in
  if not first then read_ret input #frame (false)
  else
    let! second = (fun () -> same input #frame (next at) 46uy) in
    let! third = (fun () -> same input #frame (plus at 2ul) 46uy) in
    read_ret input #frame (second && third)

let predicate_name (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame at 4ul 0x74686973uL) in if anf_value_1 then read_ret input #frame ({ at = plus at 4ul; ok = true; newline = false })
  else name input #frame at false false)

type tuple_item = { item_end:parser_state; optional_item:bool; rest_item:bool }

type type_term_head = {
  term_state:parser_state; term_readonly:bool; term_byte:U8.t;
  term_keyof:bool; term_queried:bool; term_imported:bool; term_inferred:bool; term_unique:bool
}

let read_type_term_head (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt type_term_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! readonly = (fun () -> keyword input #frame state.offset 8ul 0x726561646f6e6c79uL) in
  let! st = (fun () -> if readonly then skip input #frame { state with offset = plus state.offset 8ul } else read_ret input #frame (state)) in
  let! byte = (fun () -> peek input #frame st.offset) in
  let! keyof = (fun () -> if byte = 107uy then keyword input #frame st.offset 5ul 0x6b65796f66uL else read_ret input #frame (false)) in
  let! queried = (fun () -> if byte = 116uy then keyword input #frame st.offset 6ul 0x747970656f66uL else read_ret input #frame (false)) in
  let! imported = (fun () -> if byte = 105uy then keyword input #frame st.offset 6ul 0x696d706f7274uL else read_ret input #frame (false)) in
  let! inferred = (fun () -> if byte = 105uy then keyword input #frame st.offset 5ul 0x696e666572uL else read_ret input #frame (false)) in
  let! unique = (fun () -> if byte = 117uy then keyword input #frame st.offset 6ul 0x756e69717565uL else read_ret input #frame (false)) in
  read_ret input #frame ({ term_state = st; term_readonly = readonly; term_byte = byte;
    term_keyof = keyof; term_queried = queried; term_imported = imported; term_inferred = inferred; term_unique = unique })

let unique_symbol_type (input:tape) (#frame:slprop) (st:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! symbol = (fun () -> skip input #frame { st with offset = plus st.offset 6ul }) in
  (let! anf_value_1 = (fun () -> keyword input #frame symbol.offset 6ul 0x73796d626f6cuL) in if anf_value_1 then read_ret input #frame ({ symbol with offset = plus symbol.offset 6ul })
  else read_ret input #frame (failed symbol 1ul))

type bracket_type_key = { key_end:parser_state; index_signature:bool }

let read_bracket_type_key (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt bracket_type_key (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame state 91uy)) in skip input #frame anf_value_1)) in
  let! first = (fun () -> peek input #frame start.offset) in
  let! name_end = (fun () -> (let! anf_value_2 = (fun () -> (name input #frame start.offset false false)) in read_ret input #frame (from_cursor start anf_value_2))) in
  let! tail = (fun () -> skip input #frame name_end) in
  let! colon = (fun () -> same input #frame tail.offset 58uy) in
  if tail.status = 0ul && colon then read_ret input #frame ({ key_end = tail; index_signature = true })
  else
    let! key =
      (fun () -> if first = 34uy || first = 39uy then
        (let! anf_value_3 = (fun () -> (string_end input #frame (next start.offset) first input.size true)) in read_ret input #frame (from_cursor start anf_value_3))
      else if G.decimal_digit first || first = 46uy || first = 45uy then
        (let! anf_value_4 = (fun () -> (number_end input #frame (if first = 45uy then next start.offset else start.offset))) in read_ret input #frame (from_cursor start anf_value_4))
      else
        let! this_ = (fun () -> if first = 116uy then keyword input #frame start.offset 4ul 0x74686973uL else read_ret input #frame (false)) in
        let key = if this_ then { start with offset = plus start.offset 4ul } else name_end in
        qualified_name input #frame key 64ul) in
    (let! anf_value_5 = (fun () -> (let! anf_value_6 = (fun () -> ((let! anf_value_7 = (fun () -> (skip input #frame key)) in consume input #frame anf_value_7 93uy))) in skip input #frame anf_value_6)) in read_ret input #frame ({ key_end = anf_value_5; index_signature = false }))

let type_chain_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt (parser_state & bool) (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  let! first = (fun () -> peek input #frame st.offset) in
  if first = 124uy || first = 38uy then (let! anf_value_1 = (fun () -> consume input #frame st first) in read_ret input #frame (anf_value_1, false)) else read_ret input #frame (st, true)

let constructor_type_start (input:tape) (#frame:slprop) (st:parser_state) (byte:U8.t) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start =
    (fun () -> if byte = 97uy then
      (let! anf_value_1 = (fun () -> keyword input #frame st.offset 8ul 0x6162737472616374uL) in if anf_value_1 then skip input #frame { st with offset = plus st.offset 8ul }
      else read_ret input #frame (st))
    else read_ret input #frame (st)) in
  let! new_ = (fun () -> if start.status = 0ul then keyword input #frame start.offset 3ul 0x6e6577uL else read_ret input #frame (false)) in
  if new_ then skip input #frame { start with offset = plus start.offset 3ul } else read_ret input #frame (st)

type mapped_type_head = { constraint_start:parser_state; mapped:bool }

let mapped_type_start (input:tape) (#frame:slprop) (st:parser_state) : Tot (stt mapped_type_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let ordinary = { constraint_start = st; mapped = false } in
  let! byte = (fun () -> peek input #frame st.offset) in
  let signed = byte = 43uy || byte = 45uy in
  let! start = (fun () -> if signed then (let! anf_value_1 = (fun () -> (consume input #frame st byte)) in skip input #frame anf_value_1) else read_ret input #frame (st)) in
  let! first = (fun () -> peek input #frame start.offset) in
  let! readonly = (fun () -> if first = 114uy then keyword input #frame start.offset 8ul 0x726561646f6e6c79uL else read_ret input #frame (false)) in
  let! bracket =
    (fun () -> if readonly then skip input #frame { start with offset = plus start.offset 8ul } else read_ret input #frame (start)) in
  let! opening = (fun () -> same input #frame bracket.offset 91uy) in
  if not opening || (signed && not readonly) then read_ret input #frame (ordinary)
  else
    let! key = (fun () -> (let! anf_value_2 = (fun () -> (consume input #frame bracket 91uy)) in skip input #frame anf_value_2)) in
    let! first = (fun () -> peek input #frame key.offset) in
    if not (G.identifier_start first) then read_ret input #frame (ordinary)
    else
      let! stop = (fun () -> scan_class input #frame key.offset G.Identifier) in
      let! tail = (fun () -> skip input #frame { key with offset = stop }) in
      let! in_ = (fun () -> keyword input #frame tail.offset 2ul 0x696euL) in
      if not in_ || tail.status <> 0ul then read_ret input #frame (ordinary)
      else
        let! binding = (fun () -> name input #frame key.offset false true) in
        read_ret input #frame (let constraint_start =
          if binding.ok then { tail with offset = plus tail.offset 2ul } else failed key 1ul in
        { constraint_start; mapped = true })

#push-options "--z3rlimit 30"
let rec type_reference (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 1; 0]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else
    let! named = (fun () -> type_name input #frame st) in
    let! packed = (fun () -> packed_type input #frame st.offset named.at) in
    let! undefined = (fun () -> undefined_type input #frame st.offset named.at) in
    let primitive = builtin_type packed || undefined in
    let named = from_cursor st named in
    let! reference = (fun () -> if primitive then read_ret input #frame (named) else qualified_name input #frame named 64ul) in
    if type_operator packed then read_ret input #frame (failed reference 1ul)
    else if primitive then read_ret input #frame (reference)
    else type_arguments input #frame reference fuel false
and type_arguments (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t) (allow_newline:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 0; 0]) =
  let! after = (fun () -> trivia input #frame state.offset) in
  let tail = from_cursor state after in
  if tail.status <> 0ul then read_ret input #frame (tail)
  else (let! anf_value_1 = (fun () -> same input #frame tail.offset 60uy) in if anf_value_1 then
    if (after.newline && not allow_newline) || fuel = 0ul then read_ret input #frame (failed tail 1ul)
    else (let! anf_value_2 = (fun () -> (consume input #frame tail 60uy)) in type_list input #frame anf_value_2 (minus fuel 1ul) 64ul 62uy false)
  else read_ret input #frame (state))
and type_list (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t) (close:U8.t) (allow_empty:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  let! closed = (fun () -> same input #frame st.offset close) in
  if st.status <> 0ul then read_ret input #frame (st)
  else if closed && allow_empty then consume input #frame st close
  else if remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! st = (fun () -> (let! anf_value_1 = (fun () -> (annotation_type input #frame st fuel 64ul)) in skip input #frame anf_value_1)) in
    if st.status <> 0ul then read_ret input #frame (st)
    else (let! anf_value_2 = (fun () -> same input #frame st.offset 44uy) in if anf_value_2 then
      type_list input #frame { st with offset = next st.offset } fuel (minus remaining 1ul) close true
    else consume input #frame st close)
and tuple_element (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t) (allow_constrained_infer:bool)
  : Tot (stt tuple_item (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; 0]) =
  let! rest_item = (fun () -> spread_at input #frame state.offset) in
  let! start = (fun () -> if rest_item then skip input #frame { state with offset = plus state.offset 3ul } else read_ret input #frame (state)) in
  let! first = (fun () -> peek input #frame start.offset) in
  let! label_end = (fun () -> if G.identifier_start first then scan_class input #frame start.offset G.Identifier else read_ret input #frame (start.offset)) in
  let! after_label = (fun () -> if label_end = start.offset then read_ret input #frame (start) else skip input #frame { start with offset = label_end }) in
  let! optional_label = (fun () -> if label_end = start.offset then read_ret input #frame (false) else same input #frame after_label.offset 63uy) in
  let! colon = (fun () -> if optional_label then (let! anf_value_1 = (fun () -> (consume input #frame after_label 63uy)) in skip input #frame anf_value_1) else read_ret input #frame (after_label)) in
  let! named = (fun () -> if label_end = start.offset then read_ret input #frame (false) else same input #frame colon.offset 58uy) in
  let! start = (fun () -> if named then consume input #frame colon 58uy else read_ret input #frame (start)) in
  let! value = (fun () -> annotation_type input #frame start fuel 64ul) in
  let! value = (fun () -> if value.status <> 0ul && allow_constrained_infer then
    let! item_start = (fun () -> skip input #frame start) in
    let! infer_ = (fun () -> keyword input #frame item_start.offset 5ul 0x696e666572uL) in
    if infer_ then type_terms input #frame item_start fuel 64ul false true else read_ret input #frame value
    else read_ret input #frame value) in
  let! after_value = (fun () -> trivia input #frame value.offset) in
  let annotated = from_cursor value after_value in
  let! optional_suffix = (fun () -> if named then read_ret input #frame (false) else same input #frame annotated.offset 63uy) in
  let optional_item = (named && optional_label) || optional_suffix in
  let! item_end = (fun () -> if rest_item && optional_item then read_ret input #frame (failed annotated 1ul)
    else if optional_suffix then
      // A question mark after a composite type may belong to its final operand.
      let! primary = (fun () -> (let! anf_value_2 = (fun () -> (type_reference input #frame start 0ul)) in type_suffixes input #frame anf_value_2 0ul 16ul false)) in
      if after_value.newline || primary.status <> 0ul || primary.offset <> value.offset then read_ret input #frame (failed annotated 1ul)
      else (let! anf_value_3 = (fun () -> (consume input #frame annotated 63uy)) in skip input #frame anf_value_3)
    else read_ret input #frame (annotated)) in
  read_ret input #frame ({ item_end; optional_item; rest_item })
and tuple_list (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t) (seen_optional allow_constrained_infer:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 6; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 93uy) in if anf_value_1 then consume input #frame st 93uy
  else if remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! item = (fun () -> tuple_element input #frame st fuel allow_constrained_infer) in
    let end_ = item.item_end in
    if end_.status <> 0ul then read_ret input #frame (end_)
    else if seen_optional && not item.optional_item && not item.rest_item then read_ret input #frame (failed end_ 1ul)
    else (let! anf_value_2 = (fun () -> same input #frame end_.offset 44uy) in if anf_value_2 then
      (let! anf_value_3 = (fun () -> (consume input #frame end_ 44uy)) in tuple_list input #frame anf_value_3 fuel (minus remaining 1ul) (seen_optional || item.optional_item) allow_constrained_infer)
    else consume input #frame end_ 93uy))
and object_type_member (input:tape) (#frame:slprop) (st:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 6; 0]) =
  let! is_readonly = (fun () -> keyword input #frame st.offset 8ul 0x726561646f6e6c79uL) in
  let! key_start =
    (fun () -> if is_readonly then
      let! after = (fun () -> skip input #frame { st with offset = plus st.offset 8ul }) in
      let! next_key = (fun () -> peek input #frame after.offset) in
      read_ret input #frame (if G.identifier_start next_key || next_key = 34uy || next_key = 39uy || next_key = 91uy then after else st)
    else read_ret input #frame (st)) in
  let! first = (fun () -> peek input #frame key_start.offset) in
  let! head =
    (fun () -> if first = 91uy then read_bracket_type_key input #frame key_start
    else
      let unnamed = first = 40uy || first = 60uy in
      let! key_end = (fun () -> if unnamed then read_ret input #frame (key_start) else (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (property_name input #frame key_start)) in read_ret input #frame (from_cursor key_start anf_value_2)))) in skip input #frame anf_value_1)) in
      read_ret input #frame ({ key_end; index_signature = false })) in
  if head.index_signature then
    let! key_type = (fun () -> (let! anf_value_3 = (fun () -> (consume input #frame head.key_end 58uy)) in annotation_type input #frame anf_value_3 fuel 64ul)) in
    let! last = (fun () -> (let! anf_value_4 = (fun () -> (skip input #frame key_type)) in consume input #frame anf_value_4 93uy)) in
    (let! anf_value_5 = (fun () -> ((let! anf_value_6 = (fun () -> (skip input #frame last)) in consume input #frame anf_value_6 58uy))) in annotation_type input #frame anf_value_5 fuel 64ul)
  else
    let after = head.key_end in
    let! optional = (fun () -> same input #frame after.offset 63uy) in
    let! after = (fun () -> if optional then (let! anf_value_7 = (fun () -> (consume input #frame after 63uy)) in skip input #frame anf_value_7) else read_ret input #frame (after)) in
    let! byte = (fun () -> peek input #frame after.offset) in
    if byte = 40uy || byte = 60uy then
      if key_start.offset <> st.offset || fuel = 0ul then read_ret input #frame (failed after 1ul)
      else
        let inner = minus fuel 1ul in
        let! opening = (fun () -> if byte = 60uy then (let! anf_value_8 = (fun () -> ((let! anf_value_9 = (fun () -> (consume input #frame after 60uy)) in type_parameters input #frame anf_value_9 inner 64ul))) in skip input #frame anf_value_8)
          else read_ret input #frame (after)) in
        let! parameters = (fun () -> (let! anf_value_10 = (fun () -> (consume input #frame opening 40uy)) in signature_parameters input #frame anf_value_10 inner 64ul)) in
        (let! anf_value_11 = (fun () -> ((let! anf_value_12 = (fun () -> (skip input #frame parameters)) in consume input #frame anf_value_12 58uy))) in result_type input #frame anf_value_11 fuel)
    else (let! anf_value_13 = (fun () -> (consume input #frame after 58uy)) in annotation_type input #frame anf_value_13 fuel 64ul)
and object_type (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 7; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 125uy) in if anf_value_1 then consume input #frame st 125uy
  else if remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! declared = (fun () -> object_type_member input #frame st fuel) in
    let! boundary = (fun () -> trivia input #frame declared.offset) in
    let end_ = from_cursor declared boundary in
    let! next_byte = (fun () -> peek input #frame end_.offset) in
    if end_.status <> 0ul then read_ret input #frame (end_)
    else if next_byte = 59uy || next_byte = 44uy then
      (let! anf_value_2 = (fun () -> (consume input #frame end_ next_byte)) in object_type input #frame anf_value_2 fuel (minus remaining 1ul))
    else if next_byte = 125uy then consume input #frame end_ 125uy
    else if boundary.newline then object_type input #frame end_ fuel (minus remaining 1ul)
    else read_ret input #frame (failed end_ 1ul))
and mapped_type (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 7; 0]) =
  let! source = (fun () -> annotation_type input #frame state fuel 64ul) in
  let! st = (fun () -> skip input #frame source) in
  let! as_ = (fun () -> keyword input #frame st.offset 2ul 0x6173uL) in
  let! remapped = (fun () -> if as_ then annotation_type input #frame { st with offset = plus st.offset 2ul } fuel 64ul else read_ret input #frame (st)) in
  let! after = (fun () -> (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (skip input #frame remapped)) in consume input #frame anf_value_2 93uy))) in skip input #frame anf_value_1)) in
  let! byte = (fun () -> peek input #frame after.offset) in
  let! optional =
    (fun () -> if byte = 43uy || byte = 45uy then (let! anf_value_3 = (fun () -> ((let! anf_value_4 = (fun () -> (consume input #frame after byte)) in skip input #frame anf_value_4))) in consume input #frame anf_value_3 63uy)
    else if byte = 63uy then consume input #frame after 63uy
    else read_ret input #frame (after)) in
  let! st = (fun () -> skip input #frame optional) in
  let! colon = (fun () -> same input #frame st.offset 58uy) in
  let! value = (fun () -> if colon then (let! anf_value_5 = (fun () -> ((let! anf_value_6 = (fun () -> (consume input #frame st 58uy)) in annotation_type input #frame anf_value_6 fuel 64ul))) in skip input #frame anf_value_5) else read_ret input #frame (st)) in
  let! byte = (fun () -> peek input #frame value.offset) in
  let! end_ = (fun () -> if byte = 59uy || byte = 44uy then (let! anf_value_7 = (fun () -> (consume input #frame value byte)) in skip input #frame anf_value_7) else read_ret input #frame (value)) in
  consume input #frame end_ 125uy
and braced_type (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 8; 0]) =
  let! start = (fun () -> skip input #frame state) in
  let! head = (fun () -> mapped_type_start input #frame start) in
  if head.mapped then mapped_type input #frame head.constraint_start fuel
  else object_type input #frame start fuel input.size
and signature_parameters (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 41uy) in if anf_value_1 then consume input #frame st 41uy
  else if remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! spread = (fun () -> spread_at input #frame st.offset) in
    let! st = (fun () -> if spread then skip input #frame { st with offset = plus st.offset 3ul } else read_ret input #frame (st)) in
    let! receiver = (fun () -> if remaining = 64ul then keyword input #frame st.offset 4ul 0x74686973uL else read_ret input #frame (false)) in
    let! named = (fun () -> if receiver && not spread then read_ret input #frame ({ st with offset = plus st.offset 4ul })
      else (let! anf_value_2 = (fun () -> (name input #frame st.offset false false)) in read_ret input #frame (from_cursor st anf_value_2))) in
    let! tail = (fun () -> skip input #frame named) in
    let! optional = (fun () -> same input #frame tail.offset 63uy) in
    let! tail = (fun () -> if optional && not receiver && not spread then (let! anf_value_3 = (fun () -> (consume input #frame tail 63uy)) in skip input #frame anf_value_3) else read_ret input #frame (tail)) in
    let! annotated = (fun () -> (let! anf_value_4 = (fun () -> (consume input #frame tail 58uy)) in annotation_type input #frame anf_value_4 fuel 64ul)) in
    let! end_ = (fun () -> skip input #frame annotated) in
    let! comma = (fun () -> same input #frame end_.offset 44uy) in
    if comma && not spread then
      (let! anf_value_5 = (fun () -> (consume input #frame end_ 44uy)) in signature_parameters input #frame anf_value_5 fuel (minus remaining 1ul))
    else consume input #frame end_ 41uy)
and type_term (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t) (allow_signature allow_constrained_infer:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 2; 0]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else
    let! head = (fun () -> read_type_term_head input #frame st) in
    let st = head.term_state in
    let readonly = head.term_readonly in
    let byte = head.term_byte in
    let keyof = head.term_keyof in
    let queried = head.term_queried in
    let imported = head.term_imported in
    let! constructor = (fun () -> if byte = 110uy || byte = 97uy then constructor_type_start input #frame st byte else read_ret input #frame (st)) in
    let! primary =
      (fun () -> if keyof then
        if readonly || fuel = 0ul then read_ret input #frame (failed st 1ul)
        else type_term input #frame { st with offset = plus st.offset 5ul } (minus fuel 1ul) false allow_constrained_infer
      else if queried then
        let! query = (fun () -> type_query input #frame st) in
        type_arguments input #frame query.query_end fuel query.is_import
      else if imported then (let! anf_value_1 = (fun () -> (import_type input #frame st)) in type_arguments input #frame anf_value_1 fuel true)
      else if head.term_unique then unique_symbol_type input #frame st
      else if head.term_inferred then
        let! start = (fun () -> skip input #frame { st with offset = plus st.offset 5ul }) in
        let! binding = (fun () -> (let! anf_value_2 = (fun () -> (name input #frame start.offset false true)) in read_ret input #frame (from_cursor start anf_value_2))) in
        let! gap = (fun () -> trivia input #frame binding.offset) in
        let tail = from_cursor binding gap in
        let! constrained = (fun () -> if allow_constrained_infer && tail.status = 0ul && not gap.newline then
            keyword input #frame tail.offset 7ul 0x657874656e6473uL
          else read_ret input #frame (false)) in
        if not constrained then read_ret input #frame (binding)
        else if fuel = 0ul then read_ret input #frame (failed tail 1ul)
        else
          let! start, allow_signature = (fun () -> type_chain_start input #frame { tail with offset = plus tail.offset 7ul }) in
          type_terms input #frame start (minus fuel 1ul) 64ul allow_signature true
      else if byte = 34uy || byte = 39uy then
        (let! anf_value_3 = (fun () -> (string_end input #frame (next st.offset) byte input.size true)) in read_ret input #frame (from_cursor st anf_value_3))
      else if byte = 96uy then
        if fuel = 0ul then read_ret input #frame (failed st 1ul)
        else template_type input #frame { st with offset = next st.offset } (minus fuel 1ul) input.size
      else if G.decimal_digit byte || byte = 45uy || byte = 46uy then
        let start = if byte = 45uy then next st.offset else st.offset in
        (let! anf_value_4 = (fun () -> (number_end input #frame start)) in read_ret input #frame (from_cursor st anf_value_4))
      else if byte = 60uy || constructor.offset <> st.offset then
        if readonly || fuel = 0ul || not allow_signature then read_ret input #frame (failed st 1ul)
        else function_type input #frame constructor (minus fuel 1ul)
      else if byte = 91uy || byte = 123uy || byte = 40uy then
        if fuel = 0ul then read_ret input #frame (failed st 1ul)
        else
          let inside = { st with offset = next st.offset } in
          let inner = minus fuel 1ul in
          if byte = 91uy then tuple_list input #frame inside inner 64ul false allow_constrained_infer
          else if byte = 123uy then braced_type input #frame inside inner
          else
            let! params = (fun () -> if allow_signature then signature_parameters input #frame inside inner 64ul
              else read_ret input #frame (failed inside 1ul)) in
            let! tail = (fun () -> skip input #frame params) in
            let! arrow = (fun () -> (let! anf_value_5 = (fun () -> (consume input #frame tail 61uy)) in consume input #frame anf_value_5 62uy)) in
            if arrow.status = 0ul then result_type input #frame arrow inner
            else (let! anf_value_6 = (fun () -> ((let! anf_value_7 = (fun () -> (annotation_type input #frame inside inner 64ul)) in skip input #frame anf_value_7))) in consume input #frame anf_value_6 41uy)
      else type_reference input #frame st fuel) in
    let! with_arrays = (fun () -> type_suffixes input #frame primary fuel 16ul true) in
    read_ret input #frame (if readonly && byte <> 91uy && primary.offset = with_arrays.offset then failed with_arrays 1ul
    else with_arrays)
and function_type (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 6; 0]) =
  let! generic = (fun () -> same input #frame state.offset 60uy) in
  let! start = (fun () -> if generic then (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (consume input #frame state 60uy)) in type_parameters input #frame anf_value_2 fuel 64ul))) in skip input #frame anf_value_1)
    else read_ret input #frame (state)) in
  let! params = (fun () -> (let! anf_value_3 = (fun () -> (consume input #frame start 40uy)) in signature_parameters input #frame anf_value_3 fuel 64ul)) in
  let! tail = (fun () -> skip input #frame params) in
  let! arrow = (fun () -> (let! anf_value_4 = (fun () -> (consume input #frame tail 61uy)) in consume input #frame anf_value_4 62uy)) in
  result_type input #frame arrow fuel
and template_type (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; U32.v remaining]) =
  if state.status <> 0ul then read_ret input #frame (state)
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then read_ret input #frame (failed state 1ul)
  else
    let at = state.offset in
    let! byte = (fun () -> peek input #frame at) in
    if byte = 96uy then read_ret input #frame ({ state with offset = next at })
    else
      let! interpolation = (fun () -> if byte = 36uy then same input #frame (next at) 123uy else read_ret input #frame (false)) in
      let! st =
        (fun () -> if interpolation then
          let! value = (fun () -> annotation_type input #frame { state with offset = plus at 2ul } fuel 64ul) in
          (let! anf_value_1 = (fun () -> (skip input #frame value)) in consume input #frame anf_value_1 125uy)
        else if byte = 92uy then (let! anf_value_2 = (fun () -> (escape_end input #frame at true true)) in read_ret input #frame (from_cursor state anf_value_2))
        else read_ret input #frame ({ state with offset = next at })) in
      template_type input #frame st fuel (minus remaining 1ul)
and type_suffixes (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t) (indexed:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 0; U32.v remaining]) =
  let! after = (fun () -> trivia input #frame state.offset) in
  let st = from_cursor state after in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 91uy) in if anf_value_1 then
    if after.newline then read_ret input #frame (state)
    else if remaining = 0ul then read_ret input #frame (failed st 1ul)
    else
      let! inner = (fun () -> (let! anf_value_2 = (fun () -> (consume input #frame st 91uy)) in skip input #frame anf_value_2)) in
      let! empty = (fun () -> same input #frame inner.offset 93uy) in
      let! index =
        (fun () -> if empty then read_ret input #frame (inner)
        else if not indexed || fuel = 0ul then read_ret input #frame (failed inner 1ul)
        else (let! anf_value_3 = (fun () -> (annotation_type input #frame inner (minus fuel 1ul) 64ul)) in skip input #frame anf_value_3)) in
      let! closed = (fun () -> consume input #frame index 93uy) in
      type_suffixes input #frame closed fuel (minus remaining 1ul) indexed
  else read_ret input #frame (state))
and annotation_type (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 4; 0]) =
  let! start, allow_signature = (fun () -> type_chain_start input #frame state) in
  let! check = (fun () -> type_terms input #frame start fuel remaining allow_signature false) in
  let! boundary = (fun () -> trivia input #frame check.offset) in
  let tail = from_cursor check boundary in
  let! extends = (fun () -> if tail.status = 0ul && not boundary.newline then
      keyword input #frame tail.offset 7ul 0x657874656e6473uL
    else read_ret input #frame (false)) in
  if not extends then read_ret input #frame (check)
  else if fuel = 0ul then read_ret input #frame (failed tail 1ul)
  else
    let inner = minus fuel 1ul in
    let! start, allow_signature = (fun () -> type_chain_start input #frame { tail with offset = plus tail.offset 7ul }) in
    let! constraint = (fun () -> type_terms input #frame start inner remaining allow_signature true) in
    let! yes = (fun () -> (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (skip input #frame constraint)) in consume input #frame anf_value_2 63uy))) in annotation_type input #frame anf_value_1 inner remaining)) in
    (let! anf_value_3 = (fun () -> ((let! anf_value_4 = (fun () -> (skip input #frame yes)) in consume input #frame anf_value_4 58uy))) in annotation_type input #frame anf_value_3 inner remaining)
and result_type (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; 0]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else
    let! asserts = (fun () -> keyword input #frame st.offset 7ul 0x61737365727473uL) in
    let! target = (fun () -> if asserts then trivia input #frame (plus st.offset 7ul)
      else read_ret input #frame ({ at = st.offset; ok = true; newline = false })) in
    let! named = (fun () -> predicate_name input #frame target.at) in
    let! tail = (fun () -> trivia input #frame named.at) in
    let! ambiguous = (fun () -> if asserts then keyword input #frame target.at 2ul 0x6973uL else read_ret input #frame (false)) in
    let! is_ = (fun () -> if target.ok && not target.newline && named.ok && tail.ok && (asserts || not tail.newline) then
      keyword input #frame tail.at 2ul 0x6973uL
      else read_ret input #frame (false)) in
    if ambiguous then read_ret input #frame (failed st 1ul)
    else if is_ then annotation_type input #frame { st with offset = plus tail.at 2ul } fuel 64ul
    else if asserts && target.ok && not target.newline && named.ok then read_ret input #frame ({ st with offset = named.at })
    else annotation_type input #frame st fuel 64ul
and type_terms (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t) (allow_signature allow_constrained_infer:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 3; U32.v remaining]) =
  if remaining = 0ul then read_ret input #frame (failed state 1ul)
  else
    let! term = (fun () -> type_term input #frame state fuel allow_signature allow_constrained_infer) in
    let! st = (fun () -> skip input #frame term) in
    let! byte = (fun () -> peek input #frame st.offset) in
    if st.status <> 0ul then read_ret input #frame (st)
    else
      let! union = (fun () -> if byte = 124uy || byte = 38uy then
        let! repeated = (fun () -> same input #frame (next st.offset) byte) in read_ret input #frame (not repeated)
      else read_ret input #frame (false)) in
      if union then type_terms input #frame { st with offset = next st.offset } fuel (minus remaining 1ul) false allow_constrained_infer
      else read_ret input #frame (term)

and type_parameters (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul || remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! st = (fun () -> (let! anf_value_1 = (fun () -> keyword input #frame st.offset 5ul 0x636f6e7374uL) in if anf_value_1 then
      skip input #frame { st with offset = plus st.offset 5ul }
      else read_ret input #frame (st))) in
    let! named = (fun () -> name input #frame st.offset false true) in
    let! packed = (fun () -> packed_type input #frame st.offset named.at) in
    let! undefined = (fun () -> undefined_type input #frame st.offset named.at) in
    let! st = (fun () -> skip input #frame (from_cursor st named)) in
    if builtin_type packed || type_operator packed || undefined then read_ret input #frame (failed st 1ul)
    else
      let! extends = (fun () -> keyword input #frame st.offset 7ul 0x657874656e6473uL) in
      let! st = (fun () -> if extends then
        (let! anf_value_2 = (fun () -> (annotation_type input #frame { st with offset = plus st.offset 7ul } fuel 64ul)) in skip input #frame anf_value_2)
        else read_ret input #frame (st)) in
      let! st = (fun () -> (let! anf_value_3 = (fun () -> same input #frame st.offset 61uy) in if anf_value_3 then
        (let! anf_value_4 = (fun () -> ((let! anf_value_5 = (fun () -> (consume input #frame st 61uy)) in annotation_type input #frame anf_value_5 fuel 64ul))) in skip input #frame anf_value_4)
        else read_ret input #frame (st))) in
      if st.status <> 0ul then read_ret input #frame (st)
      else (let! anf_value_6 = (fun () -> same input #frame st.offset 44uy) in if anf_value_6 then
        let! after = (fun () -> (let! anf_value_7 = (fun () -> (consume input #frame st 44uy)) in skip input #frame anf_value_7)) in
        (let! anf_value_8 = (fun () -> same input #frame after.offset 62uy) in if anf_value_8 then consume input #frame after 62uy
        else type_parameters input #frame after fuel (minus remaining 1ul))
      else consume input #frame st 62uy)

#pop-options

let simple_annotation (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  let! annotation = (fun () -> same input #frame st.offset 58uy) in
  if st.status <> 0ul then read_ret input #frame (st)
  else if not annotation then read_ret input #frame (state)
  else annotation_type input #frame { st with offset = next st.offset } 16ul 64ul

let result_annotation (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  (let! anf_value_1 = (fun () -> same input #frame st.offset 58uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> (consume input #frame st 58uy)) in result_type input #frame anf_value_2 16ul)
  else read_ret input #frame (st))

let expression_type_arguments (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> (consume input #frame state 60uy)) in type_list input #frame anf_value_1 16ul 64ul 62uy false)

let call_type_arguments (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! arguments = (fun () -> (let! anf_value_1 = (fun () -> (expression_type_arguments input #frame state)) in skip input #frame anf_value_1)) in
  (let! anf_value_2 = (fun () -> same input #frame arguments.offset 40uy) in if anf_value_2 then read_ret input #frame (arguments) else read_ret input #frame (failed arguments 1ul))

let optional_type_parameters (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if state.status <> 0ul then read_ret input #frame (state)
  else (let! anf_value_1 = (fun () -> same input #frame state.offset 60uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> (consume input #frame state 60uy)) in type_parameters input #frame anf_value_2 16ul 64ul)
  else read_ret input #frame (state))

let forbidden_field_arguments (input:tape) (#frame:slprop) (st:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if st.super_context <> ClassField then read_ret input #frame (false)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 97uy) in if anf_value_1 then keyword input #frame (next st.offset) 8ul 0x7267756d656e7473uL
  else read_ret input #frame (false))

let simple_default (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! equal = (fun () -> same input #frame state.offset 61uy) in
  if state.status <> 0ul || not equal then read_ret input #frame (state)
  else
    let! st = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame state 61uy)) in skip input #frame anf_value_1)) in
    let! first = (fun () -> peek input #frame st.offset) in
    let! value =
      (fun () -> (let! anf_value_2 = (fun () -> forbidden_field_arguments input #frame st) in if anf_value_2 then read_ret input #frame (failed st 1ul)
      else if first = 34uy || first = 39uy then (let! anf_value_3 = (fun () -> (string_end input #frame (next st.offset) first input.size true)) in read_ret input #frame (from_cursor st anf_value_3))
      else if G.decimal_digit first || first = 46uy then (let! anf_value_4 = (fun () -> (number_end input #frame st.offset)) in read_ret input #frame (from_cursor st anf_value_4))
      else if first = 45uy then (let! anf_value_5 = (fun () -> (number_end input #frame (next st.offset))) in read_ret input #frame (from_cursor st anf_value_5))
      else if first = 123uy || first = 91uy then
        let closed = if first = 123uy then 125uy else 93uy in
        (let! anf_value_6 = (fun () -> ((let! anf_value_7 = (fun () -> (consume input #frame st first)) in skip input #frame anf_value_7))) in consume input #frame anf_value_6 closed)
      else
        let! width = (fun () -> if first = 116uy then ((let! anf_value_8 = (fun () -> keyword input #frame st.offset 4ul 0x74727565uL) in if anf_value_8 then read_ret input #frame (4ul) else read_ret input #frame (0ul)))
          else if first = 102uy then ((let! anf_value_9 = (fun () -> keyword input #frame st.offset 5ul 0x66616c7365uL) in if anf_value_9 then read_ret input #frame (5ul) else read_ret input #frame (0ul)))
          else if first = 110uy then ((let! anf_value_10 = (fun () -> keyword input #frame st.offset 4ul 0x6e756c6cuL) in if anf_value_10 then read_ret input #frame (4ul) else read_ret input #frame (0ul)))
          else read_ret input #frame (0ul)) in
        if width = 0ul then (let! anf_value_11 = (fun () -> (name input #frame st.offset false false)) in read_ret input #frame (from_cursor st anf_value_11))
        else read_ret input #frame ({ st with offset = plus st.offset width }))) in
    skip input #frame value


type parameter_list = { names:named_state; non_simple:bool }
type function_shape = { after_function:parser_state; signature_only:bool }
type parameter_arity =
  | OrdinaryParameters
  | GetterParameters
  | SetterParameters


let rest_parameter (input:tape) (state:parser_state) (floor used:names_used) : Tot (stt parameter_list (heap input) (fun _ -> heap input)) =
  let! named = (fun () -> skip input { state with offset = plus state.offset 3ul }) in
  let! rest = (fun () -> bind_since input named binding_region_width floor used named.offset) in
  let! end_ = (fun () -> (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (simple_annotation input rest.state)) in skip input anf_value_2))) in consume input anf_value_1 41uy)) in
  ret input ({ names = { rest with state = end_ }; non_simple = true })

let arrow_token (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if state.status <> 0ul then read_ret input #frame (state)
  else
    let! tail = (fun () -> trivia input #frame state.offset) in
    let st = from_cursor state tail in
    let! equal = (fun () -> same input #frame st.offset 61uy) in
    let! greater = (fun () -> same input #frame (next st.offset) 62uy) in
    read_ret input #frame (if not tail.newline && equal && greater then { st with offset = plus st.offset 2ul }
    else failed st 1ul)

let generic_arrow_head (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! head = (fun () -> consume input #frame state 60uy) in
  let! eligible =
    (fun () -> if not head.jsx_allowed then read_ret input #frame (true)
    else
      let! first = (fun () -> skip input #frame head) in
      (let! anf_value_1 = (fun () -> keyword input #frame first.offset 5ul 0x636f6e7374uL) in if anf_value_1 then read_ret input #frame (true)
      else
        let! named = (fun () -> name input #frame first.offset false true) in
        let! tail = (fun () -> skip input #frame (from_cursor first named)) in
        let! byte = (fun () -> peek input #frame tail.offset) in
        if tail.status <> 0ul then read_ret input #frame (false)
        else if byte = 44uy || byte = 61uy then read_ret input #frame (true)
        else if byte = 101uy then keyword input #frame tail.offset 7ul 0x657874656e6473uL
        else read_ret input #frame (false))) in
  if eligible then (let! anf_value_2 = (fun () -> (type_parameters input #frame head 16ul 64ul)) in skip input #frame anf_value_2) else read_ret input #frame (failed head 1ul)

let async_modifier (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> same input #frame start 97uy) in if anf_value_1 then
    (let! anf_value_2 = (fun () -> keyword input #frame start 5ul 0x6173796e63uL) in if anf_value_2 then
      let! after = (fun () -> trivia input #frame (plus start 5ul)) in
      read_ret input #frame ({ after with ok = after.ok && not after.newline })
    else read_ret input #frame ({ at = start; ok = false; newline = false }))
  else read_ret input #frame ({ at = start; ok = false; newline = false }))

type accessor_head = { arity:parameter_arity; key_start:parser_state }

let accessor_modifier (input:tape) (#frame:slprop) (st:parser_state) : Tot (stt accessor_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame st.offset) in
  let! kind =
    (fun () -> if first = 103uy then
      (let! anf_value_1 = (fun () -> keyword input #frame st.offset 3ul 0x676574uL) in if anf_value_1 then read_ret input #frame (GetterParameters) else read_ret input #frame (OrdinaryParameters))
    else if first = 115uy then
      (let! anf_value_2 = (fun () -> keyword input #frame st.offset 3ul 0x736574uL) in if anf_value_2 then read_ret input #frame (SetterParameters) else read_ret input #frame (OrdinaryParameters))
    else read_ret input #frame (OrdinaryParameters)) in
  let ordinary = { arity = OrdinaryParameters; key_start = st } in
  if kind = OrdinaryParameters then read_ret input #frame (ordinary)
  else
    let! key = (fun () -> skip input #frame { st with offset = plus st.offset 3ul }) in
    let! byte = (fun () -> peek input #frame key.offset) in
    let! decimal = (fun () -> if byte = 46uy then (let! anf_value_3 = (fun () -> (peek input #frame (next key.offset))) in read_ret input #frame (G.decimal_digit anf_value_3)) else read_ret input #frame (G.decimal_digit byte)) in
    read_ret input #frame (if G.identifier_start byte || byte = 34uy || byte = 39uy || byte = 91uy || decimal then
      { arity = kind; key_start = key }
    else ordinary)

let async_function (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! after = (fun () -> async_modifier input #frame start) in
  if after.ok then
    let! is_function = (fun () -> keyword input #frame after.at 8ul 0x66756e6374696f6euL) in
    read_ret input #frame ({ after with ok = is_function })
  else read_ret input #frame (after)

let function_start (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame start) in
  if byte = 102uy then
    let! ok = (fun () -> keyword input #frame start 8ul 0x66756e6374696f6euL) in
    read_ret input #frame ({ at = start; ok; newline = false })
  else if byte = 97uy then async_function input #frame start
  else read_ret input #frame ({ at = start; ok = false; newline = false })

type generator_head = { after_star:parser_state; generator:bool }

let read_generator_head (input:tape) (#frame:slprop) (start:parser_state)
  : Tot (stt generator_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! generator = (fun () -> same input #frame start.offset 42uy) in
  let! after_star = (fun () -> if generator then skip input #frame { start with offset = next start.offset }
    else read_ret input #frame start) in
  read_ret input #frame { after_star; generator }

let function_body (input:tape) (#frame:slprop) (state:parser_state) (non_simple:bool) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if not non_simple || state.status <> 0ul then read_ret input #frame (state)
  else
    // Non-simple parameters have an early error for a strict directive in the prologue.
    let! first = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame state 123uy)) in skip input #frame anf_value_1)) in
    let! byte = (fun () -> peek input #frame first.offset) in
    read_ret input #frame (if byte = 34uy || byte = 39uy then failed state 1ul else state)

let proto_key (input:tape) (#frame:slprop) (first last:U32.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if minus last first <> 9ul then read_ret input #frame (false)
  else
    let! start = (fun () -> word input #frame first 8ul 0uL) in
    let! last = (fun () -> peek input #frame (plus first 8ul)) in
    read_ret input #frame (start = 0x5f5f70726f746f5fuL && last = 95uy)

let statement_kind (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame at) in
  if byte = 105uy then ((let! anf_value_1 = (fun () -> keyword input #frame at 2ul 0x6966uL) in if anf_value_1 then read_ret input #frame (1ul) else read_ret input #frame (0ul)))
  else if byte = 119uy then ((let! anf_value_2 = (fun () -> keyword input #frame at 5ul 0x7768696c65uL) in if anf_value_2 then read_ret input #frame (2ul) else read_ret input #frame (0ul)))
  else if byte = 100uy then ((let! anf_value_3 = (fun () -> keyword input #frame at 2ul 0x646fuL) in if anf_value_3 then read_ret input #frame (3ul) else read_ret input #frame (0ul)))
  else if byte = 102uy then ((let! anf_value_4 = (fun () -> keyword input #frame at 3ul 0x666f72uL) in if anf_value_4 then read_ret input #frame (4ul) else read_ret input #frame (0ul)))
  else if byte = 116uy then ((let! anf_value_5 = (fun () -> keyword input #frame at 3ul 0x747279uL) in if anf_value_5 then read_ret input #frame (5ul) else read_ret input #frame (0ul)))
  else if byte = 123uy then read_ret input #frame (6ul)
  else if byte = 115uy then ((let! anf_value_6 = (fun () -> keyword input #frame at 6ul 0x737769746368uL) in if anf_value_6 then read_ret input #frame (7ul) else read_ret input #frame (0ul)))
  else read_ret input #frame (0ul)

let update_width (input:tape) (#frame:slprop) (at:U32.t) (byte:U8.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if byte = 43uy || byte = 45uy then
    (let! anf_value_1 = (fun () -> same input #frame (next at) byte) in if anf_value_1 then read_ret input #frame (2ul) else read_ret input #frame (0ul))
  else read_ret input #frame (0ul)

let ambiguous_assertion_update (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! question = (fun () -> skip input #frame state) in
  let! marker = (fun () -> same input #frame question.offset 63uy) in
  if question.status <> 0ul || not marker then read_ret input #frame (false)
  else
    let! body = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame question 63uy)) in skip input #frame anf_value_1)) in
    let! first = (fun () -> peek input #frame body.offset) in
    let! update = (fun () -> update_width input #frame body.offset first) in
    read_ret input #frame (body.status = 0ul && update <> 0ul)

let assignment_width (input:tape) (#frame:slprop) (at:U32.t) (byte follower:U8.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if byte = 61uy && follower <> 61uy && follower <> 62uy then read_ret input #frame (1ul)
  else if (byte = 60uy || byte = 62uy) && follower = byte then
    let! width = (fun () -> shift_width input #frame at byte) in
    (let! anf_value_1 = (fun () -> same input #frame (plus at width) 61uy) in if anf_value_1 then read_ret input #frame (next width) else read_ret input #frame (0ul))
  else if (byte = 38uy || byte = 124uy || byte = 63uy) && follower = byte then
    (let! anf_value_2 = (fun () -> same input #frame (plus at 2ul) 61uy) in if anf_value_2 then read_ret input #frame (3ul) else read_ret input #frame (0ul))
  else read_ret input #frame (if follower <> 61uy then 0ul
  else if byte = 43uy || byte = 45uy || byte = 42uy || byte = 47uy || byte = 37uy ||
    byte = 38uy || byte = 124uy || byte = 94uy then 2ul
  else 0ul)

let identifier_target (input:tape) (#frame:slprop) (pos:U32.t) (ch:U8.t) : Tot (stt assignment_target (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! restricted =
    (fun () -> if ch = 101uy then keyword input #frame pos 4ul 0x6576616cuL
    else if ch = 97uy then keyword input #frame (next pos) 8ul 0x7267756d656e7473uL
    else read_ret input #frame (false)) in
  read_ret input #frame (if restricted then NotAssignable else Assignable)

let import_expression_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! after = (fun () -> trivia input #frame (plus state.offset 6ul)) in
  let! byte = (fun () -> peek input #frame after.at) in
  read_ret input #frame (after.ok && (byte = 40uy || byte = 46uy))

let statement_end (input:tape) (#frame:slprop) (state:parser_state) (end_at:U32.t) (before_brace:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if state.status <> 0ul then read_ret input #frame (state)
  else
    let! tail = (fun () -> trivia input #frame end_at) in
    let st = from_cursor state tail in
    let! byte = (fun () -> peek input #frame st.offset) in
    if byte = 59uy then consume input #frame st 59uy
    else read_ret input #frame (if tail.newline || st.offset = input.size || (before_brace && byte = 125uy) then st
    else failed st 1ul)

let local_width (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame start) in
  if first = 99uy then ((let! anf_value_1 = (fun () -> keyword input #frame start 5ul 0x636f6e7374uL) in if anf_value_1 then read_ret input #frame (5ul) else read_ret input #frame (0ul)))
  else if first = 108uy then ((let! anf_value_2 = (fun () -> keyword input #frame start 3ul 0x6c6574uL) in if anf_value_2 then read_ret input #frame (3ul) else read_ret input #frame (0ul)))
  else read_ret input #frame (0ul)

let type_declaration_width (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame start) in
  let! width =
    (fun () -> if first = 105uy then ((let! anf_value_1 = (fun () -> keyword input #frame start 9ul 0x6e74657266616365uL) in if anf_value_1 then read_ret input #frame (9ul) else read_ret input #frame (0ul)))
    else if first = 116uy then ((let! anf_value_2 = (fun () -> keyword input #frame start 4ul 0x74797065uL) in if anf_value_2 then read_ret input #frame (4ul) else read_ret input #frame (0ul)))
    else read_ret input #frame (0ul)) in
  if width = 0ul then read_ret input #frame (width)
  else
    let! named = (fun () -> trivia input #frame (plus start width)) in
    let! byte = (fun () -> peek input #frame named.at) in
    read_ret input #frame (if named.ok && not named.newline && G.identifier_start byte then width else 0ul)

let admissible_type_binding (input:tape) (#frame:slprop) (first last:U32.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! packed = (fun () -> packed_type input #frame first last) in
  let! undefined = (fun () -> undefined_type input #frame first last) in
  read_ret input #frame (not (builtin_type packed || undefined || type_operator packed))

let type_alias_tail (input:tape) (#frame:slprop) (state:parser_state) (before_brace:bool) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (optional_type_parameters input #frame state)) in skip input #frame anf_value_1)) in
  let! alias = (fun () -> (let! anf_value_2 = (fun () -> (consume input #frame st 61uy)) in annotation_type input #frame anf_value_2 16ul 64ul)) in
  statement_end input #frame alias alias.offset before_brace

let local_type_alias (input:tape) (state:parser_state) (floor used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! start = (fun () -> skip input { state with offset = plus state.offset 4ul }) in
  let! decl = (fun () -> bind_since input start binding_region_width floor used start.offset) in
  let! valid = (fun () -> admissible_type_binding input start.offset decl.state.offset) in
  let! st = (fun () -> if valid then type_alias_tail input decl.state true else ret input (failed decl.state 1ul)) in
  ret input ({ decl with state = { st with local_names = decl.used } })

let tag_space (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! at = (fun () -> scan_class input #frame state.offset G.Space) in
  read_ret input #frame ({ state with offset = at })

let rec jsx_tag_name (input:tape) (#frame:slprop) (at remaining:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! segment = (fun () -> name input #frame at true false) in
  if not segment.ok then read_ret input #frame (segment)
  else (let! anf_value_1 = (fun () -> same input #frame segment.at 46uy) in if anf_value_1 then
    if remaining = 0ul then read_ret input #frame ({ segment with ok = false })
    else jsx_tag_name input #frame (next segment.at) (minus remaining 1ul)
  else read_ret input #frame (segment))

let rec quote_end (input:tape) (#frame:slprop) (at:U32.t) (delimiter:U8.t) (fuel:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if U32.(at >=^ input.size) || fuel = 0ul then read_ret input #frame (at)
  else
    let! byte = (fun () -> peek input #frame at) in
    if byte = delimiter then read_ret input #frame (at) else quote_end input #frame (next at) delimiter (minus fuel 1ul)

type jsx_opening = { after_tag:parser_state; self_closing:bool }

type postfix_head = {
  after_trivia:parser_state; after_types:parser_state; token:U8.t;
  update:U32.t; type_call:bool; instantiated:bool; optional_chain:bool; non_null:bool
}

let instantiation_follower (input:tape) (#frame:slprop) (type_end after:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame after.offset) in
  if byte = 60uy || (byte = 62uy && type_end.offset <> after.offset) then
    let! second = (fun () -> peek input #frame (next after.offset)) in
    read_ret input #frame (second = byte || second = 61uy)
  else read_ret input #frame (false)

type generic_postfix = { type_cursor:parser_state; calls:bool; instantiates:bool }

let read_generic_postfix (input:tape) (#frame:slprop) (st:parser_state) (allow_instantiation:bool)
  : Tot (stt generic_postfix (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! generic = (fun () -> expression_type_arguments input #frame st) in
  let! after = (fun () -> skip input #frame generic) in
  let! call = (fun () -> if after.status = 0ul then same input #frame after.offset 40uy else read_ret input #frame (false)) in
  let! instantiates =
    (fun () -> if after.status = 0ul && not call && allow_instantiation then instantiation_follower input #frame generic after
    else read_ret input #frame (false)) in
  read_ret input #frame ({ type_cursor = if call then after else generic; calls = call; instantiates })

let postfix_start (input:tape) (#frame:slprop) (base:parsed) : Tot (stt postfix_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! after = (fun () -> trivia input #frame base.parser.offset) in
  let st = from_cursor base.parser after in
  let! byte = (fun () -> peek input #frame st.offset) in
  let! increment = (fun () -> if after.newline then read_ret input #frame (0ul) else update_width input #frame st.offset byte) in
  let! generic =
    (fun () -> if byte = 60uy && st.offset = base.range.G.last && (can_assign base.target || base.target = OptionalChain) then
      read_generic_postfix input #frame st (can_assign base.target)
    else read_ret input #frame ({ type_cursor = failed st 1ul; calls = false; instantiates = false })) in
  let! optional =
    (fun () -> if byte = 63uy then
      let! dot = (fun () -> same input #frame (next st.offset) 46uy) in
      let! digit = (fun () -> peek input #frame (plus st.offset 2ul)) in
      read_ret input #frame (dot && not (G.decimal_digit digit))
    else read_ret input #frame (false)) in
  let! bang = (fun () -> if byte = 33uy && not after.newline then
      let! equality = (fun () -> same input #frame (next st.offset) 61uy) in read_ret input #frame (not equality)
    else read_ret input #frame (false)) in
  read_ret input #frame ({ after_trivia = st; after_types = generic.type_cursor; token = byte;
    update = increment; type_call = generic.calls; instantiated = generic.instantiates; optional_chain = optional; non_null = bang })

let class_keyword (input:tape) (#frame:slprop) (offset:U32.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  keyword input #frame offset 5ul 0x636c617373uL

type class_key = {
  after_key:parser_state; first:U32.t; last:U32.t; static_:bool; async_:bool; readonly_:bool; arity:parameter_arity;
  generator_:bool; private_:bool; quoted_:bool; modifier_flags:U32.t
}

type pending_overload = { key_span:G.span; key_flags:U32.t; key_async:bool }

let no_overload : pending_overload = { key_span = { G.first = 0ul; G.last = 0ul }; key_flags = 0ul; key_async = false }

let class_key_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame state.offset) in
  read_ret input #frame (G.identifier_start byte || byte = 34uy || byte = 39uy || byte = 42uy || byte = 35uy)

type class_prefix = { key_state:parser_state; flags:U32.t }

let class_modifier_width (input:tape) (#frame:slprop) (at:U32.t) (first:U8.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if first = 115uy then ((let! anf_value_1 = (fun () -> keyword input #frame at 6ul 0x737461746963uL) in if anf_value_1 then read_ret input #frame (6ul) else read_ret input #frame (0ul)))
  else if first = 114uy then ((let! anf_value_2 = (fun () -> keyword input #frame at 8ul 0x726561646f6e6c79uL) in if anf_value_2 then read_ret input #frame (8ul) else read_ret input #frame (0ul)))
  else if first = 111uy then ((let! anf_value_3 = (fun () -> keyword input #frame at 8ul 0x6f76657272696465uL) in if anf_value_3 then read_ret input #frame (8ul) else read_ret input #frame (0ul)))
  else if first <> 112uy then read_ret input #frame (0ul)
  else (let! anf_value_4 = (fun () -> keyword input #frame at 6ul 0x7075626c6963uL) in if anf_value_4 then read_ret input #frame (6ul)
  else (let! anf_value_5 = (fun () -> keyword input #frame at 7ul 0x70726976617465uL) in if anf_value_5 then read_ret input #frame (7ul)
  else
    let! prefix = (fun () -> word input #frame at 8ul 0uL) in
    if prefix = 0x70726f7465637465uL then
      (let! anf_value_6 = (fun () -> keyword input #frame (plus at 8ul) 1ul 0x64uL) in if anf_value_6 then read_ret input #frame (9ul) else read_ret input #frame (0ul))
    else read_ret input #frame (0ul)))

let rec class_modifiers (input:tape) (#frame:slprop) (st:parser_state) (flags fuel:U32.t)
  : Tot (stt class_prefix (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let ordinary = { key_state = st; flags } in
  if st.status <> 0ul then read_ret input #frame (ordinary)
  else
    let! first = (fun () -> peek input #frame st.offset) in
    let! width = (fun () -> class_modifier_width input #frame st.offset first) in
    if width = 0ul then read_ret input #frame (ordinary)
    else
      let! gap = (fun () -> trivia input #frame (plus st.offset width)) in
      let after = from_cursor st gap in
      let! modifier = (fun () -> class_key_start input #frame after) in
      if not modifier || (gap.newline && first <> 115uy) then read_ret input #frame (ordinary)
      else
        let bit = if first = 115uy then 1ul else if first = 114uy then 2ul else if first = 111uy then 8ul else 4ul in
        if fuel = 0ul || U32.logand bit flags <> 0ul then read_ret input #frame ({ ordinary with key_state = failed st 1ul })
        else class_modifiers input #frame after (U32.logor bit flags) (minus fuel 1ul)

let class_member_key (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt class_key (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! prefix = (fun () -> class_modifiers input #frame state 0ul 4ul) in
  let start = prefix.key_state in
  let! modifier = (fun () -> async_modifier input #frame start.offset) in
  let after_async = if modifier.ok then { start with offset = modifier.at } else start in
  let! async_ = (fun () -> if modifier.ok then class_key_start input #frame after_async else read_ret input #frame (false)) in
  let method_start = if async_ then after_async else start in
  let! generator = (fun () -> read_generator_head input #frame method_start) in
  let! accessor = (fun () -> accessor_modifier input #frame generator.after_star) in
  let key_start = accessor.key_start in
  let! byte = (fun () -> peek input #frame key_start.offset) in
  let quoted = byte = 34uy || byte = 39uy in
  let private_ = byte = 35uy in
  let! key = (fun () -> if private_ then private_identifier input #frame key_start.offset else property_name input #frame key_start) in
  read_ret input #frame (let key_end = if private_ && U32.logand prefix.flags 12ul <> 0ul then failed key_start 1ul
    else from_cursor key_start key in
  let first = if quoted then next key_start.offset else key_start.offset in
  let last = if quoted then minus key.at 1ul else key.at in
  { after_key = key_end; first; last; async_; arity = accessor.arity; generator_ = generator.generator; private_;
    quoted_ = quoted; modifier_flags = prefix.flags;
    static_ = U32.logand prefix.flags 1ul <> 0ul; readonly_ = U32.logand prefix.flags 2ul <> 0ul })

let constructor_property (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame state.offset) in
  if first <> 112uy && first <> 114uy then read_ret input #frame (state)
  else
    let! prefixes = (fun () -> class_modifiers input #frame state 0ul 2ul) in
    let property = prefixes.key_state in
    if property.status <> 0ul || prefixes.flags = 0ul || U32.logand prefixes.flags 9ul <> 0ul then read_ret input #frame (state)
    else
      let! binding = (fun () -> name input #frame property.offset false true) in
      let! tail = (fun () -> trivia input #frame binding.at) in
      let! optional = (fun () -> same input #frame tail.at 63uy) in
      let! colon = (fun () -> if optional then trivia input #frame (next tail.at) else read_ret input #frame (tail)) in
      let! typed = (fun () -> same input #frame colon.at 58uy) in
      read_ret input #frame (if binding.ok && tail.ok && colon.ok && typed then property else state)

let wide_key_matches (input:tape) (#frame:slprop) (key:class_key) (suffix_size:U32.t) (prefix suffix:U64.t) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if minus key.last key.first <> plus 8ul suffix_size then read_ret input #frame (false)
  else
    let! a = (fun () -> word input #frame key.first 8ul 0uL) in
    let! b = (fun () -> word input #frame (plus key.first 8ul) suffix_size 0uL) in
    read_ret input #frame (a = prefix && b = suffix)

type array_run = { inside:parser_state; openers:U32.t }

let rec array_openers (input:tape) (#frame:slprop) (state:parser_state) (count remaining:U32.t)
  : Tot (stt array_run (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input #frame state) in
  let! opening = (fun () -> same input #frame st.offset 91uy) in
  if st.status <> 0ul || not opening || remaining = 0ul then read_ret input #frame ({ inside = st; openers = count })
  else (let! anf_value_1 = (fun () -> (consume input #frame st 91uy)) in array_openers input #frame anf_value_1 (next count) (minus remaining 1ul))

let rec array_closers (input:tape) (#frame:slprop) (state:parser_state) (count:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v count) =
  if state.status <> 0ul || count = 0ul then read_ret input #frame (state)
  else
    let! st = (fun () -> (let! anf_value_1 = (fun () -> (skip input #frame state)) in consume input #frame anf_value_1 93uy)) in
    array_closers input #frame st (minus count 1ul)

let rec interface_bases (input:tape) (#frame:slprop) (state:parser_state) (remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul || remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! named = (fun () -> name input #frame st.offset false false) in
    if not named.ok then read_ret input #frame (failed st 1ul)
    else
      let! ending = (fun () -> (let! anf_value_1 = (fun () -> (type_reference input #frame st 16ul)) in skip input #frame anf_value_1)) in
      (let! anf_value_2 = (fun () -> same input #frame ending.offset 44uy) in if anf_value_2 then
        (let! anf_value_3 = (fun () -> (consume input #frame ending 44uy)) in interface_bases input #frame anf_value_3 (minus remaining 1ul))
      else read_ret input #frame (ending))

type atom_head = {
  token_:U8.t; imported_:bool; super_:bool; fn_:cursor;
  increment_:U32.t; deleting_:bool; prefix_:U32.t; constructor_:bool; class_:bool
}

let read_atom_head (input:tape) (#frame:slprop) (st:parser_state) : Tot (stt atom_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let start_pos = st.offset in
  let! ch = (fun () -> peek input #frame start_pos) in
  let! imported = (fun () -> if ch = 105uy then keyword input #frame start_pos 6ul 0x696d706f7274uL else read_ret input #frame (false)) in
  let! super_ = (fun () -> if ch = 115uy && st.super_context <> NoSuper then
    keyword input #frame start_pos 5ul 0x7375706572uL else read_ret input #frame (false)) in
  let! function_head = (fun () -> function_start input #frame start_pos) in
  let! increment = (fun () -> update_width input #frame start_pos ch) in
  let! await_ =
    (fun () -> if st.await_allowed && ch = 97uy then keyword input #frame start_pos 5ul 0x6177616974uL
    else read_ret input #frame (false)) in
  let! deleting = (fun () -> if ch = 100uy then keyword input #frame start_pos 6ul 0x64656c657465uL else read_ret input #frame (false)) in
  let! prefix = (fun () -> if deleting then read_ret input #frame (6ul) else if await_ then read_ret input #frame (5ul)
    else if increment <> 0ul then read_ret input #frame (increment) else unary_width input #frame start_pos ch) in
  let! constructor = (fun () -> if ch = 110uy then keyword input #frame start_pos 3ul 0x6e6577uL else read_ret input #frame (false)) in
  let! class_ = (fun () -> if ch = 99uy then class_keyword input #frame start_pos else read_ret input #frame (false)) in
  read_ret input #frame ({ token_ = ch; imported_ = imported; super_; fn_ = function_head; increment_ = increment; deleting_ = deleting; prefix_ = prefix;
    constructor_ = constructor; class_ })

let exponent_base (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! head = (fun () -> read_atom_head input #frame state) in
  read_ret input #frame (head.token_ <> 60uy && (head.prefix_ = 0ul || head.increment_ <> 0ul))

let combine_binary (input:tape) (lhs rhs:parsed) (st:parser_state) (op:binary_operator) (first:U8.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) =
  if rhs.parser.status <> 0ul then ret input (rhs)
  // Multiple opening angles and a packed right shift can be nested type arguments.
  else if op.boundary = 1ul && lhs.open_angle && rhs.right_shift then ret input (empty_range (failed rhs.parser 1ul))
  else
    let logical = (U32.(op.strength <=^ 2ul) && not op.nullish) || lhs.shortcut = 1ul || rhs.shortcut = 1ul in
    let nullish = op.nullish || lhs.shortcut = 2ul || rhs.shortcut = 2ul in
    if logical && nullish then ret input (empty_range (failed rhs.parser 1ul))
    else
      let! result = (fun () -> if op.boundary = 0ul then ret input (rhs.parser)
        else emit_comparison_in_workspace input rhs.parser st.count op.boundary st.offset lhs.range rhs.range) in
      ret input (let shortcut = if logical then 1ul else if nullish then 2ul else 0ul in
      { parser = result; range = { lhs.range with G.last = rhs.range.G.last }; shortcut;
        open_angle = lhs.open_angle || rhs.open_angle || op.boundary = 1ul;
        right_shift = lhs.right_shift || rhs.right_shift || (op.strength = 8ul && first = 62uy);
        outer_or = op.strength = 1ul && not op.nullish; target = NotAssignable })

let signature_end (input:tape) (#frame:slprop) (state opening:parser_state) (params:parameter_list) (annotation st:parser_state)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! typed = (fun () -> skip input #frame params.names.state) in
  let! annotated_return = (fun () -> same input #frame typed.offset 58uy) in
  if not annotated_return || st.count <> state.count then read_ret input #frame (failed st 1ul)
  else
    let! checked = (fun () -> if params.non_simple then signature_parameters input #frame opening 15ul 64ul else read_ret input #frame (params.names.state)) in
    if checked.status <> 0ul || checked.offset <> params.names.state.offset then read_ret input #frame (failed st 1ul)
    else statement_end input #frame annotation annotation.offset false

#push-options "--z3rlimit 30"
let rec atom (input:tape) (current:parser_state) (fuel:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 2; 0]) =
  let! st = (fun () -> skip input current) in
  let start_pos = st.offset in
  if st.status <> 0ul then ret input (empty_range st)
  else (let! anf_value_1 = (fun () -> forbidden_field_arguments input st) in if anf_value_1 then ret input (empty_range (failed st 1ul))
  else
    let! head = (fun () -> read_atom_head input st) in
    let ch = head.token_ in
    let imported = head.imported_ in
    let super_ = head.super_ in
    let function_head = head.fn_ in
    let increment = head.increment_ in
    let deleting = head.deleting_ in
    let prefix = head.prefix_ in
    let constructor = head.constructor_ in
    if prefix <> 0ul then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else
        let! child = (fun () -> atom input { st with offset = plus start_pos prefix } (minus fuel 1ul)) in
        ret input (if (increment <> 0ul && not (can_assign child.target)) ||
           (deleting && child.target <> MemberTarget && child.target <> OptionalChain) then
          empty_range (failed child.parser 1ul)
        else { child with range = { child.range with G.first = start_pos }; target = NotAssignable })
    else if function_head.ok then
      let! closed = (fun () -> function_expression input st fuel function_head.at) in
      postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
        open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if head.class_ then
      let! closed = (fun () -> class_expression input st fuel) in
      postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
        open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if super_ then super_expression input st fuel
    else if imported then
      let! after = (fun () -> skip input { st with offset = plus start_pos 6ul }) in
      let! byte = (fun () -> peek input after.offset) in
      let! closed =
        (fun () -> if byte = 40uy then
          if fuel = 0ul then ret input (failed after 3ul)
          else
            let depth = minus 65ul fuel in
            let after = if U32.(depth >^ after.depth) then { after with depth } else after in
            (let! anf_value_2 = (fun () -> (consume input after 40uy)) in dynamic_import input anf_value_2 (minus fuel 1ul))
        else if byte = 46uy && st.module_mode then
          let! meta = (fun () -> (let! anf_value_3 = (fun () -> (consume input after 46uy)) in skip input anf_value_3)) in
          (let! anf_value_4 = (fun () -> keyword input meta.offset 4ul 0x6d657461uL) in if anf_value_4 then ret input ({ meta with offset = plus meta.offset 4ul })
          else ret input (failed meta 1ul))
        else ret input (failed after 1ul)) in
      postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
        open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if ch = 60uy && st.jsx_allowed then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else
        let! closed = (fun () -> jsx_element input st (minus fuel 1ul)) in
        postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
          open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if constructor || ch = 96uy || ch = 91uy || ch = 123uy then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let st = { st with depth } in
        let inner = minus fuel 1ul in
        let! completed, target =
          (fun () -> if constructor then
            let! target = (fun () -> skip input { st with offset = plus start_pos 3ul }) in
            let! named =
              (fun () -> (let! anf_value_5 = (fun () -> forbidden_field_arguments input target) in if anf_value_5 then ret input (failed target 1ul)
              else (let! anf_value_6 = (fun () -> (name input target.offset false false)) in ret input (from_cursor target anf_value_6)))) in
            let! named = (fun () -> qualified_name input named 64ul) in
            let! tail = (fun () -> skip input named) in
            let! typed = (fun () -> same input tail.offset 60uy) in
            let! tail = (fun () -> if typed && tail.offset = named.offset then call_type_arguments input tail else ret input (tail)) in
            let! args = (fun () -> consume input tail 40uy) in
            (let! anf_value_7 = (fun () -> (let! anf_value_8 = (fun () -> (expression_list input args inner input.size 41uy false)) in ret input (anf_value_8.list_end))) in ret input (anf_value_7, NotAssignable))
          else
            let inside = { st with offset = next start_pos } in
            if ch = 96uy then (let! anf_value_9 = (fun () -> template_body input inside inner input.size false) in ret input (anf_value_9, NotAssignable))
            else if ch = 91uy then
              if U32.(inner <=^ 8ul) then (let! anf_value_10 = (fun () -> deep_array_literal input inside inner) in ret input (anf_value_10, NotAssignable))
              else
                let! row = (fun () -> expression_list input inside inner input.size 93uy true) in
                ret input (row.list_end, (if row.valid_array_target then ArrayTarget else NotAssignable))
            else (let! anf_value_11 = (fun () -> object_members input inside inner input.size false) in ret input (anf_value_11, NotAssignable))) in
        postfix input { parser = completed; range = { G.first = start_pos; G.last = completed.offset }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target }
          fuel input.size
    else if ch = 40uy then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let! inner = (fun () -> comparison input { st with offset = next start_pos; depth; in_allowed = true } (minus fuel 1ul)) in
        let! consumed = (fun () -> skip input inner.parser) in
        let! comma = (fun () -> same input consumed.offset 44uy) in
        let! done_ =
          (fun () -> if consumed.status <> 0ul || not comma then consume input consumed 41uy
          else if inner.open_angle then ret input (failed consumed 1ul)
          else (let! anf_value_12 = (fun () -> (consume input consumed 44uy)) in grouped_tail input anf_value_12 (minus fuel 1ul) input.size)) in
        let done_ = { done_ with in_allowed = st.in_allowed } in
        let target = if not comma && inner.target = AssertedTarget then AssertedTarget else NotAssignable in
        postfix input { parser = done_; range = { G.first = start_pos; G.last = done_.offset }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target }
          fuel input.size
    else if G.decimal_digit ch || ch = 46uy then
      let! number = (fun () -> number_end input start_pos) in
      postfix input { parser = from_cursor st number; range = { G.first = start_pos; G.last = number.at }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }
        fuel input.size
    else
      let! named, target =
        (fun () -> if ch = 34uy || ch = 39uy then ((let! anf_value_13 = (fun () -> (let! anf_value_14 = (fun () -> (string_end input (next start_pos) ch input.size true)) in ret input (from_cursor st anf_value_14))) in ret input (anf_value_13, NotAssignable)))
        else if ch = 47uy then ((let! anf_value_15 = (fun () -> (let! anf_value_16 = (fun () -> (regex_end input (next start_pos))) in ret input (from_cursor st anf_value_16))) in ret input (anf_value_15, NotAssignable)))
        else
          let! width =
            (fun () -> if ch = 116uy then
              let! is_this = (fun () -> keyword input start_pos 4ul 0x74686973uL) in
              if is_this then ret input (4ul) else (let! anf_value_17 = (fun () -> keyword input start_pos 4ul 0x74727565uL) in if anf_value_17 then ret input (4ul) else ret input (0ul))
            else if ch = 102uy then ((let! anf_value_18 = (fun () -> keyword input start_pos 5ul 0x66616c7365uL) in if anf_value_18 then ret input (5ul) else ret input (0ul)))
            else if ch = 110uy then ((let! anf_value_19 = (fun () -> keyword input start_pos 4ul 0x6e756c6cuL) in if anf_value_19 then ret input (4ul) else ret input (0ul)))
            else ret input (0ul)) in
          if width <> 0ul then ret input (({ st with offset = plus start_pos width }, NotAssignable))
          else ((let! anf_value_20 = (fun () -> (let! anf_value_21 = (fun () -> (name input start_pos false false)) in ret input (from_cursor st anf_value_21))) in (let! anf_value_22 = (fun () -> identifier_target input start_pos ch) in ret input (anf_value_20, anf_value_22))))) in
      let base = { parser = named; range = { G.first = start_pos; G.last = named.offset };
        open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target } in
      postfix input base fuel input.size)
and function_expression (input:tape) (st:parser_state) (fuel function_head:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 1; 0]) =
  if fuel = 0ul then ret input (failed st 3ul)
  else
    let! first = (fun () -> skip input { st with offset = plus function_head 8ul }) in
    let! generator = (fun () -> same input first.offset 42uy) in
    let! first = (fun () -> if generator then (let! anf_value_1 = (fun () -> (consume input first 42uy)) in skip input anf_value_1) else ret input (first)) in
    let! byte = (fun () -> peek input first.offset) in
    let! named =
      (fun () -> if byte = 40uy || byte = 60uy then ret input (first)
      else (let! anf_value_2 = (fun () -> (name input first.offset false true)) in ret input (from_cursor first anf_value_2))) in
    (let! anf_value_3 = (fun () -> (function_form input named (minus fuel 1ul) (st.offset <> function_head) NoSuper false OrdinaryParameters generator)) in ret input (anf_value_3.after_function))
and class_expression (input:tape) (st:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 1; 0]) =
  if fuel = 0ul then ret input (failed st 3ul)
  else
    let! body = (fun () -> skip input { st with offset = plus st.offset 5ul }) in
    let! next_ = (fun () -> peek input body.offset) in
    let! inherited = (fun () -> if next_ = 101uy then keyword input body.offset 7ul 0x657874656e6473uL else ret input (false)) in
    let! named =
      (fun () -> if inherited || next_ = 60uy || next_ = 123uy then ret input (body)
      else (let! anf_value_1 = (fun () -> (name input body.offset false true)) in ret input (from_cursor body anf_value_1))) in
    class_tail input named (minus fuel 1ul)
and super_expression (input:tape) (st:parser_state) (fuel:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 1; U32.v input.size + 1]) =
  let start_pos = st.offset in
  let! after = (fun () -> skip input { st with offset = plus start_pos 5ul }) in
  let! byte = (fun () -> peek input after.offset) in
  let! completed =
    (fun () -> if byte = 40uy && st.super_context = DerivedConstructor then
      if fuel = 0ul then ret input (failed after 3ul)
      else
        let depth = minus 65ul fuel in
        let after = if U32.(depth >^ after.depth) then { after with depth } else after in
        (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (consume input after 40uy)) in expression_list input anf_value_2 (minus fuel 1ul) input.size 41uy false))) in ret input (anf_value_1.list_end))
    else ret input (if byte = 46uy || byte = 91uy then { st with offset = plus start_pos 5ul }
    else failed after 1ul)) in
  postfix input { parser = completed; range = { G.first = start_pos; G.last = completed.offset };
    open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul;
    target = if byte = 46uy || byte = 91uy then BareSuper else NotAssignable } fuel input.size
and arrow_parameter_list (input:tape) (state:parser_state) (floor used:names_used)
  (fuel remaining:U32.t) (non_simple:bool)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 22; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ names = { state = st; used }; non_simple })
  else (let! anf_value_1 = (fun () -> same input st.offset 41uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> consume input st 41uy) in ret input ({ state = anf_value_3; used }))) in ret input ({ names = anf_value_2; non_simple }))
  else if remaining = 0ul then ret input ({ names = { state = failed st 1ul; used }; non_simple })
  else (let! anf_value_4 = (fun () -> spread_at input st.offset) in if anf_value_4 then rest_parameter input st floor used
  else
    let! prefix = (fun () -> parameter_prefix input st floor used fuel) in
    let equal = prefix.names.state in
    let! initialized = (fun () -> same input equal.offset 61uy) in
    let non_simple = non_simple || prefix.non_simple || initialized in
    let! st = (fun () -> simple_default input equal) in
    let! delimiter = (fun () -> peek input st.offset) in
    let! st =
      (fun () -> if initialized && equal.status = 0ul && equal.arrow_defaults_allowed &&
          (st.status <> 0ul || (delimiter <> 44uy && delimiter <> 41uy)) then
        if fuel = 0ul then ret input (failed equal 3ul)
        else
          // Speculation starts after the live names and candidates. Disable recursive speculation into defaults.
          let! start = (fun () -> consume input { equal with await_allowed = false; in_allowed = true;
            local_names = prefix.names.used; arrow_defaults_allowed = false } 61uy) in
          let! value = (fun () -> comparison input start (minus fuel 1ul)) in
          let! st = (fun () -> skip input value.parser) in
          let! comma = (fun () -> same input st.offset 44uy) in
          ret input (let st = if value.open_angle && comma then failed st 1ul else st in
          { st with await_allowed = equal.await_allowed; in_allowed = equal.in_allowed;
            local_names = equal.local_names; arrow_defaults_allowed = equal.arrow_defaults_allowed })
      else ret input (st)) in
    (let! anf_value_5 = (fun () -> same input st.offset 44uy) in if anf_value_5 then
      (let! anf_value_6 = (fun () -> (consume input st 44uy)) in arrow_parameter_list input anf_value_6 floor prefix.names.used fuel (minus remaining 1ul) non_simple)
    else (let! anf_value_7 = (fun () -> (let! anf_value_8 = (fun () -> consume input st 41uy) in ret input ({ prefix.names with state = anf_value_8 }))) in ret input ({ names = anf_value_7; non_simple })))))

and plain_arrow_parameters (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 23; 0]) =
  let used = state.local_names in
  let missed = { names = { state = failed state 1ul; used }; non_simple = false } in
  if state.status <> 0ul then ret input (missed)
  else
    let! byte = (fun () -> peek input state.offset) in
    let! opening = (fun () -> if byte = 60uy then generic_arrow_head input state else ret input (state)) in
    let! parenthesized = (fun () -> same input opening.offset 40uy) in
    if opening.status <> 0ul then ret input (missed)
    else if parenthesized then
      let! params = (fun () -> (let! anf_value_1 = (fun () -> (consume input opening 40uy)) in arrow_parameter_list input anf_value_1 used used fuel 64ul false)) in
      let! after = (fun () -> trivia input params.names.state.offset) in
      let st = from_cursor params.names.state after in
      let! colon = (fun () -> same input st.offset 58uy) in
      let! result =
        (fun () -> if colon && not after.newline then
          (let! anf_value_2 = (fun () -> (consume input st 58uy)) in result_type input anf_value_2 16ul)
        else ret input (params.names.state)) in
      (let! anf_value_3 = (fun () -> (let! anf_value_4 = (fun () -> arrow_token input result) in ret input ({ params.names with state = anf_value_4 }))) in ret input ({ params with names = anf_value_3 }))
    else if G.identifier_start byte then
      let! named = (fun () -> name input state.offset false true) in
      let! body = (fun () -> arrow_token input (from_cursor state named)) in
      if body.status <> 0ul then ret input (missed)
      else
        let! param = (fun () -> bind_since input state binding_region_width used used state.offset) in
        ret input ({ missed with names = { param with state = { param.state with offset = body.offset } } })
    else ret input (missed)

and arrow_parameters (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 24; 0]) =
  let! modifier = (fun () -> async_modifier input state.offset) in
  if modifier.ok && state.status = 0ul then
    let! async_ = (fun () -> plain_arrow_parameters input { state with offset = modifier.at; await_allowed = true } fuel) in
    if async_.names.state.status = 0ul || async_.names.state.status = 4ul then ret input (async_)
    else plain_arrow_parameters input { state with await_allowed = false } fuel
  else plain_arrow_parameters input { state with await_allowed = false } fuel

and comparison (input:tape) (current:parser_state) (fuel:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 25; 0]) =
  let! start = (fun () -> skip input current) in
  let! arrow = (fun () -> arrow_parameters input { start with yield_allowed = false } fuel) in
  if arrow.names.state.status = 0ul then
    let! body = (fun () -> skip input { arrow.names.state with local_names = arrow.names.used; binding_mode = NoLocals }) in
    if fuel = 0ul then ret input (empty_range (failed body 3ul))
    else
      let depth = minus 65ul fuel in
      let depth = if U32.(depth >^ body.depth) then depth else body.depth in
      let body = { body with depth } in
      let inner = minus fuel 1ul in
      let! block = (fun () -> same input body.offset 123uy) in
      let! result =
        (fun () -> if block then
          let block_start = { body with in_allowed = true } in
          let! stop = (fun () -> (let! anf_value_1 = (fun () -> (function_body input block_start arrow.non_simple)) in control_block input anf_value_1 inner true NoJump start.local_names arrow.names.used)) in
          ret input (empty_range stop)
        else
          let in_allowed = body.in_allowed && not body.for_initializer in
          comparison input { body with in_allowed } inner) in
      ret input ({ result with parser = { result.parser with local_names = start.local_names; await_allowed = start.await_allowed;
          yield_allowed = start.yield_allowed; in_allowed = start.in_allowed; binding_mode = start.binding_mode };
        range = { result.range with G.first = start.offset }; outer_or = false; shortcut = 0ul; target = NotAssignable })
  else
  let! lhs = (fun () -> binary input start fuel 1ul) in
  let st = lhs.parser in
  if st.status = 1ul && arrow.names.state.status = 4ul then ret input (empty_range { st with status = 4ul })
  else if st.status <> 0ul then ret input (lhs)
  else
    let! byte = (fun () -> peek input st.offset) in
    let! follower = (fun () -> peek input (next st.offset)) in
    let! assignment =
      (fun () -> if can_assign_expression lhs.target then assignment_width input st.offset byte follower
      else ret input (if lhs.target = ArrayTarget && byte = 61uy && follower <> 61uy && follower <> 62uy then 1ul
      else 0ul)) in
    if assignment <> 0ul then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else
        let! rhs = (fun () -> comparison input { st with offset = plus st.offset assignment } (minus fuel 1ul)) in
        ret input ({ rhs with range = { rhs.range with G.first = lhs.range.G.first };
          open_angle = lhs.open_angle || rhs.open_angle; outer_or = false; shortcut = 0ul; target = NotAssignable })
    else if byte <> 63uy || follower = 63uy || follower = 46uy then ret input (lhs)
    else if fuel = 0ul then ret input (empty_range (failed st 3ul))
    else
      let inner = minus fuel 1ul in
      let! consequent = (fun () -> comparison input { st with offset = next st.offset; in_allowed = true } inner) in
      let! colon = (fun () -> skip input { consequent.parser with in_allowed = st.in_allowed }) in
      let! alternate = (fun () -> (let! anf_value_2 = (fun () -> (consume input colon 58uy)) in comparison input anf_value_2 inner)) in
      // The conditional delimiters close the condition and consequent before any enclosing comma.
      ret input ({ alternate with range = { alternate.range with G.first = lhs.range.G.first };
        outer_or = false; shortcut = 0ul; target = NotAssignable })
and binary (input:tape) (state:parser_state) (fuel:U32.t) (minimum:precedence)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26 - U32.v minimum - U32.v minimum; 0]) =
  let! lhs = (fun () -> atom input state fuel) in
  binary_tail input lhs fuel minimum input.size
and binary_tail (input:tape) (lhs:parsed) (fuel:U32.t) (minimum:precedence) (remaining:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 25 - U32.v minimum - U32.v minimum; U32.v remaining]) =
  let! st = (fun () -> skip input lhs.parser) in
  if st.status <> 0ul then ret input (empty_range st)
  else
    let! first = (fun () -> peek input st.offset) in
    let! type_width =
      (fun () -> if U32.(minimum >^ 7ul) then ret input (0ul)
      else if first = 97uy then ((let! anf_value_1 = (fun () -> keyword input st.offset 2ul 0x6173uL) in if anf_value_1 then ret input (2ul) else ret input (0ul)))
      else if first = 115uy then
        ((let! anf_value_2 = (fun () -> keyword input (next st.offset) 8ul 0x6174697366696573uL) in if anf_value_2 then ret input (9ul) else ret input (0ul)))
      else ret input (0ul)) in
    let! assertion =
      (fun () -> if type_width = 0ul then ret input (false)
      else let! before = (fun () -> trivia input lhs.range.G.last) in ret input (not before.newline)) in
    if assertion then
      if remaining = 0ul then ret input (empty_range (failed st 3ul))
      else
        let! asserted = (fun () -> annotation_type input { st with offset = plus st.offset type_width } 16ul 64ul) in
        (let! anf_value_3 = (fun () -> ambiguous_assertion_update input asserted) in if anf_value_3 then ret input (empty_range (failed asserted 1ul))
        else
          let target = if can_assign_expression lhs.target then AssertedTarget else NotAssignable in
          let value = { lhs with parser = asserted; range = { lhs.range with G.last = asserted.offset };
            outer_or = false; target } in
          binary_tail input value fuel minimum (minus remaining 1ul))
    else
      let! op = (fun () -> operator input st.offset st.in_allowed) in
      let exponent = op.strength = 11ul in
      let! forbidden_base =
        (fun () -> if exponent then let! allowed = (fun () -> exponent_base input { st with offset = lhs.range.G.first }) in ret input (not allowed)
        else ret input (false)) in
      if op.width = 0ul || U32.(op.strength <^ minimum) then ret input ({ lhs with parser = st })
      else if remaining = 0ul then ret input (empty_range (failed st 3ul))
      else if exponent && fuel = 0ul then ret input (empty_range (failed st 3ul))
      else if forbidden_base then ret input (empty_range (failed st 1ul))
      else if lhs.open_angle && (op.boundary = 3ul || op.boundary = 4ul ||
          op.strength = 3ul || op.strength = 5ul || op.strength = 8ul) then ret input (empty_range (failed st 1ul))
      else if op.boundary <> 0ul && U32.(st.count >=^ input.capacity) then ret input (empty_range (failed st 4ul))
      else
        let count = if op.boundary = 0ul then st.count else next st.count in
        let after = { st with offset = plus st.offset op.width; count } in
        let! rhs = (fun () -> if exponent then binary input after (minus fuel 1ul) op.strength
          else binary input after fuel (U32.add op.strength 1ul)) in
        let! combined = (fun () -> combine_binary input lhs rhs st op first) in
        if combined.parser.status <> 0ul then ret input (combined)
        else binary_tail input combined fuel minimum (minus remaining 1ul)

and postfix (input:tape) (base:parsed) (fuel remaining:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 1; U32.v remaining]) =
  if base.parser.status <> 0ul then ret input (base)
  else
    let! head = (fun () -> postfix_start input base) in
    let st = head.after_trivia in
    let byte = head.token in
    let increment = head.update in
    let typed = head.type_call in
    let optional = head.optional_chain in
    let bang = head.non_null in
    if st.status <> 0ul then ret input ({ base with parser = st })
    else if head.instantiated then
      ret input ({ base with parser = head.after_types; range = { base.range with G.last = head.after_types.offset };
        target = NotAssignable })
    else if increment <> 0ul then
      ret input (if not (can_assign base.target) then empty_range (failed st 1ul)
      else
        let end_at = plus st.offset increment in
        { base with parser = { st with offset = end_at }; range = { base.range with G.last = end_at };
          target = NotAssignable })
    else if byte <> 46uy && byte <> 40uy && byte <> 91uy && byte <> 96uy &&
      not bang && not optional && not typed then ret input ({ base with parser = st })
    else if remaining = 0ul then ret input (empty_range (failed st 3ul))
    else
      let! operand =
        (fun () -> if typed then ret input (head.after_types)
        else if optional then
          let! after = (fun () -> skip input { st with offset = plus st.offset 2ul }) in
          (let! anf_value_1 = (fun () -> same input after.offset 60uy) in if anf_value_1 then call_type_arguments input after else ret input (after))
        else ret input (st)) in
      let! kind = (fun () -> if typed then ret input (40uy) else if optional then peek input operand.offset else ret input (byte)) in
      let! next_st, private_access =
        (fun () -> if kind = 40uy || kind = 91uy || kind = 96uy then
          if kind = 96uy && (optional || base.target = OptionalChain) then ret input (failed st 1ul, false)
          else if fuel = 0ul then ret input (failed st 3ul, false)
          else
            let depth = minus 65ul fuel in
            let depth = if U32.(depth >^ st.depth) then depth else st.depth in
            let inside = { operand with offset = next operand.offset; depth } in
            if kind = 40uy then (let! anf_value_2 = (fun () -> (expression_list input inside (minus fuel 1ul) input.size 41uy false)) in ret input (anf_value_2.list_end, false))
            else if kind = 96uy then
              let! tail = (fun () -> template_body input inside (minus fuel 1ul) input.size true) in ret input (tail, false)
            else
              let! index = (fun () -> comparison input inside (minus fuel 1ul)) in
              let! tail = (fun () -> consume input index.parser 93uy) in ret input (tail, false)
        else if optional || byte = 46uy then
          let! property = (fun () -> if optional then ret input (operand) else skip input { st with offset = next st.offset }) in
          let! first = (fun () -> peek input property.offset) in
          if first = 35uy && not optional && base.target <> OptionalChain && base.target <> BareSuper then
            let! name_ = (fun () -> private_identifier input property.offset) in
            let! recorded = (fun () -> record_private input (from_cursor property name_)
              { G.first = property.offset; G.last = name_.at } PrivateReference) in
            ret input (recorded, true)
          else if not (G.identifier_start first) then ret input (failed property 1ul, false)
          else (let! anf_value_3 = (fun () -> scan_class input property.offset G.Identifier) in ret input ({ property with offset = anf_value_3 }, false))
        else ret input ({ st with offset = next st.offset }, false)) in
      let target =
        if optional || base.target = OptionalChain then OptionalChain
        else if private_access then PrivateTarget
        else if kind = 46uy || kind = 91uy then MemberTarget
        else NotAssignable in
      postfix input { base with parser = next_st; range = { base.range with G.last = next_st.offset }; target }
        fuel (minus remaining 1ul)

and dynamic_import (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 28; 0]) =
  let! path = (fun () -> comparison input state fuel) in
  let! tail = (fun () -> skip input path.parser) in
  if tail.status <> 0ul then ret input (tail)
  else (let! anf_value_1 = (fun () -> same input tail.offset 41uy) in if anf_value_1 then consume input tail 41uy
  else
    let! options = (fun () -> (let! anf_value_2 = (fun () -> (consume input tail 44uy)) in skip input anf_value_2)) in
    (let! anf_value_3 = (fun () -> same input options.offset 41uy) in if anf_value_3 then consume input options 41uy
    else
      let! value = (fun () -> comparison input options fuel) in
      let! tail = (fun () -> skip input value.parser) in
      let! tail = (fun () -> (let! anf_value_4 = (fun () -> same input tail.offset 44uy) in if anf_value_4 then (let! anf_value_5 = (fun () -> (consume input tail 44uy)) in skip input anf_value_5) else ret input (tail))) in
      consume input tail 41uy))
and grouped_tail (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; U32.v remaining]) =
  if state.status <> 0ul then ret input (state)
  else if remaining = 0ul then ret input (failed state 3ul)
  else
    let! item = (fun () -> comparison input state fuel) in
    let! st = (fun () -> skip input item.parser) in
    let! comma = (fun () -> same input st.offset 44uy) in
    if st.status <> 0ul || not comma then consume input st 41uy
    else if item.open_angle then ret input (failed st 1ul)
    else (let! anf_value_1 = (fun () -> (consume input st 44uy)) in grouped_tail input anf_value_1 fuel (minus remaining 1ul))
and deep_array_literal (input:tape) (inside:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 27; 0]) =
  let! run = (fun () -> array_openers input inside 0ul input.size) in
  if U32.(run.openers <=^ fuel) then (let! anf_value_1 = (fun () -> (expression_list input inside fuel input.size 93uy false)) in ret input (anf_value_1.list_end))
  else
    // The leading wrappers cannot fit in the remaining recursive stack.
    // Read the innermost array once and accept only uninterrupted closing wrappers.
    let! deepest = (fun () -> (let! anf_value_2 = (fun () -> (expression_list input { run.inside with depth = minus 64ul fuel } fuel input.size 93uy false)) in ret input (anf_value_2.list_end))) in
    let! closed = (fun () -> array_closers input deepest run.openers) in
    ret input (let depth = plus closed.depth run.openers in
    let depth = if U32.(depth >^ inside.depth) then depth else inside.depth in
    if closed.status <> 0ul then failed inside 3ul else { closed with depth })

and expression_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (close:U8.t) (valid_array_target:bool)
  : Tot (stt expression_items (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ list_end = st; valid_array_target = false })
  else (let! anf_value_1 = (fun () -> same input st.offset close) in if anf_value_1 then (let! anf_value_2 = (fun () -> consume input st close) in ret input ({ list_end = anf_value_2; valid_array_target }))
  else if remaining = 0ul then ret input ({ list_end = failed st 3ul; valid_array_target = false })
  else
    let! hole = (fun () -> if close = 93uy then same input st.offset 44uy else ret input (false)) in
    if hole then (let! anf_value_3 = (fun () -> (consume input st 44uy)) in expression_list input anf_value_3 fuel (minus remaining 1ul) close valid_array_target)
    else
      let! spread = (fun () -> spread_at input st.offset) in
      let start = if spread then { st with offset = plus st.offset 3ul } else st in
      let! arg = (fun () -> comparison input start fuel) in
      let! st = (fun () -> skip input arg.parser) in
      let valid_array_target = valid_array_target && not spread && can_assign arg.target in
      (let! anf_value_4 = (fun () -> same input st.offset 44uy) in if anf_value_4 then
        let! next_item = (fun () -> consume input st 44uy) in
        let! next_hole = (fun () -> if arg.open_angle && close = 93uy then
          let! next_item = (fun () -> skip input next_item) in same input next_item.offset 44uy
          else ret input (false)) in
        // A generic argument list cannot continue across an array elision.
        if arg.open_angle && not next_hole then ret input ({ list_end = failed st 1ul; valid_array_target = false })
        else expression_list input next_item fuel (minus remaining 1ul) close valid_array_target
      else (let! anf_value_5 = (fun () -> consume input st close) in ret input ({ list_end = anf_value_5; valid_array_target }))))
and object_member (input:tape) (st:parser_state) (fuel:U32.t) (colon_required:bool)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; 0]) =
  let! spread = (fun () -> spread_at input st.offset) in
  if spread && not colon_required then comparison input { st with offset = plus st.offset 3ul } fuel
  else
    let! head = (fun () -> accessor_modifier input st) in
    let arity = head.arity in
    let accessor = arity <> OrdinaryParameters in
    let! modifier = (fun () -> async_modifier input st.offset) in
    let! method_byte = (fun () -> if modifier.ok then peek input modifier.at else ret input (0uy)) in
    let async_method = modifier.ok && (G.identifier_start method_byte || method_byte = 34uy ||
      method_byte = 39uy || method_byte = 91uy || method_byte = 42uy) in
    let method_start = if async_method then { st with offset = modifier.at } else head.key_start in
    let! generator = (fun () -> read_generator_head input method_start) in
    let key_start = generator.after_star in
    let! byte = (fun () -> peek input key_start.offset) in
    let quoted = byte = 34uy || byte = 39uy in
    let computed = byte = 91uy in
    let numeric = G.decimal_digit byte || byte = 46uy in
    let! end_key =
      (fun () -> if computed then
        let! key = (fun () -> comparison input { key_start with offset = next key_start.offset; in_allowed = true } fuel) in
        let! closed = (fun () -> (let! anf_value_1 = (fun () -> (skip input key.parser)) in consume input anf_value_1 93uy)) in
        ret input ({ closed with in_allowed = st.in_allowed })
      else
        let! key =
          (fun () -> if numeric then number_end input key_start.offset
          else property_name input key_start) in
        let first = if quoted then next key_start.offset else key_start.offset in
        let last = if quoted then minus key.at 1ul else key.at in
        let! prototype = (fun () -> if key.ok && not accessor then proto_key input first last else ret input (false)) in
        ret input (if prototype then failed st 1ul else from_cursor key_start key)) in
    let! after_key = (fun () -> skip input end_key) in
    let! colon = (fun () -> same input after_key.offset 58uy) in
    if after_key.status <> 0ul then ret input (empty_range after_key)
    else if colon && not async_method && not accessor && not generator.generator then (let! anf_value_2 = (fun () -> (consume input after_key 58uy)) in comparison input anf_value_2 fuel)
    else
      let! next_token = (fun () -> peek input after_key.offset) in
      if not colon_required && (next_token = 40uy || next_token = 60uy) then
        if fuel = 0ul then ret input (empty_range (failed after_key 3ul))
        else if accessor || generator.generator then
          let! form = (fun () -> function_form input after_key (minus fuel 1ul) async_method MethodSuper false arity generator.generator) in
          ret input (empty_range form.after_function)
        else (let! anf_value_5 = (fun () -> (function_tail input after_key (minus fuel 1ul) async_method NoSuper)) in ret input (empty_range anf_value_5))
      else if computed || quoted || numeric || colon_required || async_method || accessor || generator.generator then ret input (empty_range (failed st 1ul))
      else
        let! shorthand = (fun () -> name input st.offset false false) in
        let! forbidden = (fun () -> forbidden_field_arguments input st) in
        ret input (if shorthand.ok && not forbidden then empty_range after_key else empty_range (failed st 1ul))
and object_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (colon_required:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 27; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  let! byte = (fun () -> peek input st.offset) in
  if st.status <> 0ul then ret input (st)
  else if byte = 125uy then consume input st 125uy
  else if remaining = 0ul then ret input (failed st 3ul)
  else
    let! value = (fun () -> object_member input st fuel colon_required) in
    let! st = (fun () -> skip input value.parser) in
    (let! anf_value_1 = (fun () -> same input st.offset 44uy) in if anf_value_1 then
      // A colon in the next property rules out a generic argument list across the comma.
      (let! anf_value_2 = (fun () -> (consume input st 44uy)) in object_members input anf_value_2 fuel (minus remaining 1ul) value.open_angle)
    else consume input st 125uy)
and template_body (input:tape) (state:parser_state) (fuel remaining:U32.t) (tagged:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; U32.v remaining]) =
  if state.status <> 0ul then ret input (state)
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then ret input (failed state 1ul)
  else
    let at = state.offset in
    let! byte = (fun () -> peek input at) in
    let! following = (fun () -> peek input (next at)) in
    if byte = 96uy then ret input ({ state with offset = next at })
    else
      let! st =
        (fun () -> if byte = 36uy && following = 123uy then
          let! value = (fun () -> comparison input { state with offset = plus at 2ul; in_allowed = true } fuel) in
          consume input { value.parser with in_allowed = state.in_allowed } 125uy
        else if byte = 92uy then
          // Tagged templates may contain invalid cooked escapes. Only the next
          // byte can escape a template delimiter, regardless of cooked value.
          if tagged then ret input ({ state with offset = plus at 2ul })
          else (let! anf_value_1 = (fun () -> (escape_end input at true true)) in ret input (from_cursor state anf_value_1))
        else ret input ({ state with offset = next at })) in
      template_body input st fuel (minus remaining 1ul) tagged

and jsx_attribute (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 30; 0]) =
  let! first = (fun () -> peek input state.offset) in
  if first = 123uy then
    let! inner = (fun () -> (let! anf_value_1 = (fun () -> (consume input state 123uy)) in skip input anf_value_1)) in
    let! spread = (fun () -> spread_at input inner.offset) in
    if not spread then ret input (failed inner 1ul)
    else
      let! value = (fun () -> comparison input { inner with offset = plus inner.offset 3ul } fuel) in
      (let! anf_value_2 = (fun () -> (skip input value.parser)) in consume input anf_value_2 125uy)
  else
    let! named = (fun () -> name input state.offset true false) in
    let named_state = from_cursor state named in
    let! tail = (fun () -> tag_space input named_state) in
    let! equal = (fun () -> same input tail.offset 61uy) in
    if named_state.status <> 0ul || not equal then ret input (named_state)
    else
      let! st = (fun () -> (let! anf_value_3 = (fun () -> (consume input tail 61uy)) in tag_space input anf_value_3)) in
      let! byte = (fun () -> peek input st.offset) in
      if byte = 34uy || byte = 39uy then
        let! pos = (fun () -> quote_end input (next st.offset) byte input.size) in
        consume input { st with offset = pos } byte
      else if byte = 60uy then
        if fuel = 0ul then ret input (failed st 3ul)
        else
          let! opening = (fun () -> tag_space input { st with offset = next st.offset }) in
          let! fragment = (fun () -> same input opening.offset 62uy) in
          let! nested = (fun () -> jsx_element input st (minus fuel 1ul)) in
          let! next_attr = (fun () -> tag_space input nested) in
          let! first = (fun () -> peek input next_attr.offset) in
          ret input (if fragment && G.identifier_start first then failed nested 1ul else nested)
      else
        let! value = (fun () -> (let! anf_value_4 = (fun () -> (consume input st 123uy)) in comparison input anf_value_4 fuel)) in
        let! st = (fun () -> skip input value.parser) in
        // Delegate the focused rewrite for a direct disabled disjunction.
        let! disabled = (fun () -> if value.outer_or && minus named.at state.offset = 8ul then
          let! attr_name = (fun () -> word input state.offset 8ul 0uL) in ret input (attr_name = 0x64697361626c6564uL)
          else ret input (false)) in
        if disabled then ret input (failed st 1ul) else consume input st 125uy

and jsx_attributes (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt jsx_opening (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 31; U32.v remaining]) =
  let! st = (fun () -> tag_space input state) in
  let! byte = (fun () -> peek input st.offset) in
  if st.status <> 0ul then ret input ({ after_tag = st; self_closing = false })
  else if byte = 62uy then (let! anf_value_1 = (fun () -> consume input st 62uy) in ret input ({ after_tag = anf_value_1; self_closing = false }))
  else if byte = 47uy then
    (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> ((let! anf_value_4 = (fun () -> (consume input st 47uy)) in tag_space input anf_value_4))) in consume input anf_value_3 62uy)) in ret input ({ after_tag = anf_value_2; self_closing = true }))
  else if remaining = 0ul then ret input ({ after_tag = failed st 1ul; self_closing = false })
  else
    let! following = (fun () -> jsx_attribute input st fuel) in
    jsx_attributes input following fuel (minus remaining 1ul)

and jsx_children (input:tape) (state:parser_state) (tag:G.span) (fuel remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 32; U32.v remaining]) =
  if state.status <> 0ul then ret input (state)
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then ret input (failed state 1ul)
  else
    let! byte = (fun () -> peek input state.offset) in
    if byte = 60uy then
      let! slash = (fun () -> same input (next state.offset) 47uy) in
      if slash then
        let! closing = (fun () -> tag_space input { state with offset = plus state.offset 2ul }) in
        let length = minus tag.G.last tag.G.first in
        if length = 0ul then consume input closing 62uy
        else
          let! named = (fun () -> jsx_tag_name input closing.offset 64ul) in
          let! same_ =
            (fun () -> if named.ok && minus named.at closing.offset = length then
              same_bytes input tag.G.first closing.offset length
            else ret input (false)) in
          if same_ then (let! anf_value_1 = (fun () -> (tag_space input (from_cursor closing named))) in consume input anf_value_1 62uy)
          else ret input (failed closing 1ul)
      else if fuel = 0ul then ret input (failed state 3ul)
      else
        let! child = (fun () -> jsx_element input state (minus fuel 1ul)) in
        jsx_children input child tag fuel (minus remaining 1ul)
    else if byte = 123uy then
      let! st = (fun () -> (let! anf_value_2 = (fun () -> (consume input state 123uy)) in skip input anf_value_2)) in
      let! done_ =
        (fun () -> (let! anf_value_3 = (fun () -> same input st.offset 125uy) in if anf_value_3 then consume input st 125uy
        else
          let! value = (fun () -> comparison input st fuel) in
          (let! anf_value_4 = (fun () -> (skip input value.parser)) in consume input anf_value_4 125uy))) in
      jsx_children input done_ tag fuel (minus remaining 1ul)
    else if byte = 0uy || byte = 62uy || byte = 125uy then ret input (failed state 1ul)
    else jsx_children input { state with offset = next state.offset } tag fuel (minus remaining 1ul)

and jsx_element (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 33; 0]) =
  let depth = minus 64ul fuel in
  let state = if U32.(depth >^ state.depth) then { state with depth } else state in
  let! opening = (fun () -> (let! anf_value_1 = (fun () -> (consume input state 60uy)) in tag_space input anf_value_1)) in
  (let! anf_value_2 = (fun () -> same input opening.offset 62uy) in if anf_value_2 then
    (let! anf_value_3 = (fun () -> (consume input opening 62uy)) in jsx_children input anf_value_3 (start_range opening.offset) fuel input.size)
  else
    let! named = (fun () -> jsx_tag_name input opening.offset 64ul) in
    let! attrs = (fun () -> jsx_attributes input (from_cursor opening named) fuel input.size) in
    if attrs.after_tag.status <> 0ul || attrs.self_closing then ret input (attrs.after_tag)
    else jsx_children input attrs.after_tag { G.first = opening.offset; G.last = named.at } fuel input.size)

and condition (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 43; 0]) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (skip input state)) in consume input anf_value_1 40uy)) in
  let! tested = (fun () -> comparison input st fuel) in
  (let! anf_value_2 = (fun () -> (skip input tested.parser)) in consume input anf_value_2 41uy)

and variable_initializer (input:tape) (state:parser_state) (fuel:U32.t) (optional before_brace:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 43; 0]) =
  let! value = (fun () -> declarator_value input state fuel optional) in
  statement_end input value.parser value.range.G.last before_brace

and declarator_value (input:tape) (state:parser_state) (fuel:U32.t) (optional:bool)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 42; 0]) =
  let! after_name = (fun () -> trivia input state.offset) in
  let tail = from_cursor state after_name in
  if tail.status <> 0ul then ret input (empty_range tail)
  else
    let! byte = (fun () -> peek input tail.offset) in
    if optional && not after_name.newline && byte = 33uy then
      let! colon = (fun () -> (let! anf_value_1 = (fun () -> (consume input tail 33uy)) in skip input anf_value_1)) in
      let! annotation = (fun () -> (let! anf_value_2 = (fun () -> (consume input colon 58uy)) in annotation_type input anf_value_2 16ul 64ul)) in
      let! next_token = (fun () -> skip input annotation) in
      (let! anf_value_3 = (fun () -> same input next_token.offset 61uy) in if anf_value_3 then ret input (empty_range (failed next_token 1ul))
      else ret input (empty_range annotation))
    else
      let! annotation = (fun () -> if byte = 58uy then (let! anf_value_4 = (fun () -> (consume input tail 58uy)) in annotation_type input anf_value_4 16ul 64ul) else ret input (state)) in
      let! st = (fun () -> if byte = 58uy then skip input annotation else ret input (tail)) in
      (let! anf_value_5 = (fun () -> same input st.offset 61uy) in if anf_value_5 then
        (let! anf_value_6 = (fun () -> (consume input st 61uy)) in comparison input anf_value_6 fuel)
      else ret input (if optional then empty_range annotation
      else empty_range (failed st 1ul)))

and binding (input:tape) (state:parser_state) (fuel:U32.t) (in_allowed:bool) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 43; 0]) =
  let! st = (fun () -> skip input state) in
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (name input st.offset false true)) in ret input (from_cursor st anf_value_1))) in
  let! st = (fun () -> (let! anf_value_2 = (fun () -> (skip input st)) in consume input anf_value_2 61uy)) in
  let for_initializer = state.for_initializer || not in_allowed in
  let! value = (fun () -> comparison input { st with in_allowed; for_initializer } fuel) in
  ret input ({ value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer })

and for_bindings (input:tape) (state:parser_state) (fuel remaining:U32.t) (floor:names_used) (constant:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input (st)
  else if remaining = 0ul then ret input (failed st 1ul)
  else
    let! first = (fun () -> peek input st.offset) in
    let! declared = (fun () -> pattern_binding input st binding_region_width floor st.local_names fuel) in
    let! annotated = (fun () -> simple_annotation input { declared.state with local_names = declared.used }) in
    let! tail = (fun () -> skip input annotated) in
    let! equal = (fun () -> same input tail.offset 61uy) in
    let! initialized =
      (fun () -> if equal then
        let! value = (fun () -> (let! anf_value_1 = (fun () -> (consume input { tail with in_allowed = false; for_initializer = true } 61uy)) in comparison input anf_value_1 fuel)) in
        ret input ({ value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer })
      else ret input (if constant || first = 91uy || first = 123uy then failed tail 1ul
      else tail)) in
    let! tail = (fun () -> skip input initialized) in
    (let! anf_value_2 = (fun () -> same input tail.offset 44uy) in if anf_value_2 then
      (let! anf_value_3 = (fun () -> (consume input tail 44uy)) in for_bindings input anf_value_3 fuel (minus remaining 1ul) floor constant)
    else ret input (tail))

and for_expressions (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_allowed:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; U32.v remaining]) =
  if state.status <> 0ul then ret input (state)
  else if remaining = 0ul then ret input (failed state 1ul)
  else
    let for_initializer = state.for_initializer || not in_allowed in
    let! value = (fun () -> comparison input { state with in_allowed; for_initializer } fuel) in
    let! tail = (fun () -> skip input { value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer }) in
    (let! anf_value_1 = (fun () -> same input tail.offset 44uy) in if anf_value_1 then
      (let! anf_value_2 = (fun () -> (consume input tail 44uy)) in for_expressions input anf_value_2 fuel (minus remaining 1ul) in_allowed)
    else ret input (tail))

and classic_for_header (input:tape) (st:parser_state) (top_level local_var:bool) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let! lexical = (fun () -> local_width input st.offset) in
  let! var = (fun () -> if lexical = 0ul && (top_level || local_var) then keyword input st.offset 3ul 0x766172uL else ret input (false)) in
  let! st =
    (fun () -> (let! anf_value_1 = (fun () -> same input st.offset 59uy) in if anf_value_1 then ret input (st)
    else if lexical <> 0ul then
      let st = if local_var then record_binding_mode st LexicalLocals else st in
      for_bindings input { st with offset = plus st.offset lexical } fuel 64ul st.local_names (lexical = 5ul)
    else if var then
      let st = if local_var then record_binding_mode st VarLocals else st in
      binding input { st with offset = plus st.offset 3ul } fuel false
    else for_expressions input st fuel 64ul false)) in
  let! st = (fun () -> (let! anf_value_2 = (fun () -> (skip input st)) in consume input anf_value_2 59uy)) in
  let! st = (fun () -> skip input st) in
  let! st = (fun () -> (let! anf_value_3 = (fun () -> same input st.offset 59uy) in if anf_value_3 then ret input (st) else for_expressions input st fuel 64ul true)) in
  let! st = (fun () -> (let! anf_value_4 = (fun () -> (skip input st)) in consume input anf_value_4 59uy)) in
  let! st = (fun () -> skip input st) in
  let! st = (fun () -> (let! anf_value_5 = (fun () -> same input st.offset 41uy) in if anf_value_5 then ret input (st) else for_expressions input st fuel 64ul true)) in
  (let! anf_value_6 = (fun () -> (skip input st)) in consume input anf_value_6 41uy)

and for_header (input:tape) (state:parser_state) (top_level local_var:bool) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 46; 0]) =
  let! head = (fun () -> skip input state) in
  let! async_ = (fun () -> if head.await_allowed then keyword input head.offset 5ul 0x6177616974uL else ret input (false)) in
  let! head = (fun () -> if async_ then skip input { head with offset = plus head.offset 5ul } else ret input (head)) in
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (consume input head 40uy)) in skip input anf_value_1)) in
  let! collection = (fun () -> collection_head input st (not async_) local_var fuel) in
  if collection.status = 0ul then
    let! value = (fun () -> comparison input collection fuel) in
    (let! anf_value_2 = (fun () -> (skip input value.parser)) in consume input anf_value_2 41uy)
  else if async_ then ret input (collection)
  else classic_for_header input st top_level local_var fuel

and return_statement (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; 0]) =
  let after = plus state.offset 6ul in
  let! body = (fun () -> trivia input after) in
  let st = from_cursor state body in
  let! byte = (fun () -> peek input st.offset) in
  if byte = 59uy || byte = 125uy || body.newline then statement_end input st after true
  else
    let! value = (fun () -> comparison input st fuel) in
    statement_end input value.parser value.range.G.last true
and yield_statement (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; 0]) =
  let head = plus state.offset 5ul in
  let! after = (fun () -> trivia input head) in
  let st = from_cursor state after in
  let! byte = (fun () -> peek input st.offset) in
  if byte = 59uy || byte = 125uy || after.newline then statement_end input st head true
  else
    let! start =
      (fun () -> if byte = 42uy then
        let! operand = (fun () -> trivia input (next st.offset)) in
        ret input (if operand.newline then failed st 1ul else from_cursor st operand)
      else ret input (st)) in
    let! value = (fun () -> comparison input start fuel) in
    statement_end input value.parser value.range.G.last true

and ordinary_statement (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let! function_head = (fun () -> function_start input state.offset) in
  let! block = (fun () -> same input state.offset 123uy) in
  let! first = (fun () -> peek input state.offset) in
  let! class_ = (fun () -> if first = 99uy then class_keyword input state.offset else ret input (false)) in
  if block || function_head.ok || class_ then ret input (failed state 1ul)
  else
    let! value = (fun () -> comparison input state fuel) in
    statement_end input value.parser value.range.G.last true

and simple_statement (input:tape) (state:parser_state) (in_function:bool) (jumps:jump_context) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 46; 0]) =
  let! byte = (fun () -> peek input state.offset) in
  let! is_return =
    (fun () -> if byte = 114uy && in_function then keyword input state.offset 6ul 0x72657475726euL else ret input (false)) in
  let! is_yield =
    (fun () -> if byte = 121uy && state.yield_allowed then keyword input state.offset 5ul 0x7969656c64uL else ret input (false)) in
  let! is_throw = (fun () -> if byte = 116uy then keyword input state.offset 5ul 0x7468726f77uL else ret input (false)) in
  let! jump =
    (fun () -> if byte = 98uy then ((let! anf_value_1 = (fun () -> keyword input state.offset 5ul 0x627265616buL) in if anf_value_1 then ret input (5ul) else ret input (0ul)))
    else if byte = 99uy then ((let! anf_value_2 = (fun () -> keyword input state.offset 8ul 0x636f6e74696e7565uL) in if anf_value_2 then ret input (8ul) else ret input (0ul)))
    else ret input (0ul)) in
  if is_return then return_statement input state fuel
  else if is_yield then yield_statement input state fuel
  else if jump <> 0ul then
    if jumps = LoopJump || (jumps = BreakOnly && jump = 5ul) then statement_end input state (plus state.offset jump) true
    else ret input (failed state 1ul)
  else if is_throw then
    let! body = (fun () -> trivia input (plus state.offset 5ul)) in
    let st = from_cursor state body in
    if body.newline then ret input (failed st 1ul)
    else
      let! value = (fun () -> comparison input st fuel) in
      statement_end input value.parser value.range.G.last true
  else if byte = 59uy then consume input state 59uy
  else ordinary_statement input state fuel

and local_var_declaration (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let st = record_binding_mode state VarLocals in
  let! start = (fun () -> skip input { st with offset = plus st.offset 3ul }) in
  let! named = (fun () -> (let! anf_value_1 = (fun () -> (name input start.offset false true)) in ret input (from_cursor start anf_value_1))) in
  variable_initializer input named fuel true true

and local_declarators (input:tape) (state:parser_state) (constant:bool) (floor used:names_used) (fuel remaining:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; U32.v remaining]) =
  let! start = (fun () -> skip input state) in
  if start.status <> 0ul || remaining = 0ul then ret input ({ state = failed start 1ul; used })
  else
    let! first = (fun () -> peek input start.offset) in
    let! decl = (fun () -> pattern_binding input start binding_region_width floor used fuel) in
    let named = { decl.state with local_names = decl.used } in
    let! value = (fun () -> declarator_value input named fuel (not constant && G.identifier_start first)) in
    let! tail = (fun () -> skip input value.parser) in
    if tail.status <> 0ul then ret input ({ decl with state = tail })
    else (let! anf_value_1 = (fun () -> (let! anf_value_2 = (fun () -> (same input tail.offset 44uy)) in ret input (not anf_value_2))) in if anf_value_1 then
      (let! anf_value_3 = (fun () -> statement_end input value.parser value.range.G.last true) in ret input ({ decl with state = anf_value_3 }))
    else if value.open_angle then ret input ({ decl with state = failed tail 1ul })
    else (let! anf_value_4 = (fun () -> (consume input tail 44uy)) in local_declarators input anf_value_4 constant floor decl.used fuel (minus remaining 1ul)))

and local_declaration (input:tape) (state:parser_state) (width:U32.t) (floor used:names_used) (fuel:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let state = record_binding_mode state LexicalLocals in
  local_declarators input { state with offset = plus state.offset width } (width <> 3ul) floor used fuel input.size

and scope_statement (input:tape) (st:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (root_control:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 48; 0]) =
  let! width = (fun () -> if root_control then ret input (0ul) else local_width input st.offset) in
  let! function_head = (fun () -> if root_control || not (st.module_mode || (in_function && st.strict_script)) then ret input ({ at = st.offset; ok = false; newline = false })
    else function_start input st.offset) in
  let! class_ = (fun () -> if root_control || not st.module_mode then ret input (false) else
    let! first = (fun () -> peek input st.offset) in if first = 99uy then class_keyword input st.offset else ret input (false)) in
  if width <> 0ul then local_declaration input st width floor used fuel
  else if function_head.ok then
    if fuel = 0ul then ret input ({ state = failed st 3ul; used })
    else
      let declared = record_binding_mode st LexicalLocals in
      let! named = (fun () -> skip input { declared with offset = plus function_head.at 8ul }) in
      let! head = (fun () -> read_generator_head input named) in
      let named = head.after_star in
      let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
      let start = { decl.state with local_names = decl.used } in
      let! form = (fun () -> function_form input start (minus fuel 1ul) (st.offset <> function_head.at) NoSuper false OrdinaryParameters head.generator) in
      ret input ({ decl with state = form.after_function })
  else if class_ then
    if fuel = 0ul then ret input ({ state = failed st 3ul; used })
    else
      let declared = record_binding_mode st LexicalLocals in
      let! named = (fun () -> skip input { declared with offset = plus st.offset 5ul }) in
      let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
      let start = { decl.state with local_names = decl.used } in
      (let! anf_value_2 = (fun () -> class_tail input start (minus fuel 1ul)) in ret input ({ decl with state = anf_value_2 }))
  else control_statement input st fuel in_function jumps floor used root_control
and control_sequence (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (root_control:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 49; U32.v remaining]) =
  let! st = (fun () -> skip input { state with local_names = used }) in
  let! closed = (fun () -> same input st.offset 125uy) in
  if st.status <> 0ul || st.offset = input.size || closed then ret input (st)
  else if remaining = 0ul then ret input (failed st 1ul)
  else
    let! statement = (fun () -> scope_statement input st fuel in_function jumps floor used root_control) in
    control_sequence input statement.state fuel (minus remaining 1ul) in_function jumps floor statement.used root_control
and switch_sequence (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (has_label seen_default:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 50; U32.v remaining]) =
  let! st = (fun () -> skip input { state with local_names = used }) in
  let! closed = (fun () -> same input st.offset 125uy) in
  if st.status <> 0ul || closed then ret input (st)
  else if st.offset = input.size || remaining = 0ul then ret input (failed st 1ul)
  else
    let left = minus remaining 1ul in
    let! byte = (fun () -> peek input st.offset) in
    let! case_ = (fun () -> if byte = 99uy then keyword input st.offset 4ul 0x63617365uL else ret input (false)) in
    let! default_ = (fun () -> if byte = 100uy then keyword input st.offset 7ul 0x64656661756c74uL else ret input (false)) in
    if case_ then
      let! test = (fun () -> comparison input { st with offset = plus st.offset 4ul } fuel) in
      let! colon = (fun () -> (let! anf_value_1 = (fun () -> (skip input test.parser)) in consume input anf_value_1 58uy)) in
      switch_sequence input colon fuel left in_function jumps floor used true seen_default
    else if default_ then
      if seen_default then ret input (failed st 1ul)
      else
        let! colon = (fun () -> (let! anf_value_2 = (fun () -> (skip input { st with offset = plus st.offset 7ul })) in consume input anf_value_2 58uy)) in
        switch_sequence input colon fuel left in_function jumps floor used true true
    else if not has_label then ret input (failed st 1ul)
    else
      let! statement = (fun () -> scope_statement input st fuel in_function jumps floor used false) in
      switch_sequence input statement.state fuel left in_function jumps floor statement.used true seen_default
and control_block (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (floor used:names_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 51; 0]) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (skip input state)) in consume input anf_value_1 123uy)) in
  let! st = (fun () -> control_sequence input { st with local_names = used } fuel input.size in_function jumps floor used false) in
  consume input { st with local_names = state.local_names } 125uy
and control_statement (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (allow_var:bool) : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 47; 0]) =
  let! kind = (fun () -> statement_kind input state.offset) in
  if state.status <> 0ul then ret input ({ state; used })
  else if kind = 0ul then
    let local_var = in_function && state.module_mode in
    let! first = (fun () -> peek input state.offset) in
    let! alias = (fun () -> if local_var && first = 116uy then (let! anf_value_1 = (fun () -> type_declaration_width input state.offset) in ret input (anf_value_1 = 4ul)) else ret input (false)) in
    let! var = (fun () -> if local_var && first = 118uy then keyword input state.offset 3ul 0x766172uL else ret input (false)) in
    if alias then local_type_alias input state floor used
    else if var then (let! anf_value_2 = (fun () -> local_var_declaration input state fuel) in ret input ({ state = anf_value_2; used }))
    else (let! anf_value_3 = (fun () -> simple_statement input state in_function jumps fuel) in ret input ({ state = anf_value_3; used }))
  else if fuel = 0ul then ret input ({ state = failed state 3ul; used })
  else
    let inner = minus fuel 1ul in
    let depth = minus 65ul fuel in
    let state = if U32.(depth >^ state.depth) then { state with depth } else state in
    if kind = 1ul || kind = 2ul then
      let width = if kind = 1ul then 2ul else 5ul in
      let! tested = (fun () -> condition input { state with offset = plus state.offset width } fuel) in
      let body_jumps = if kind = 2ul then LoopJump else jumps in
      let! body = (fun () -> control_body input tested inner in_function body_jumps floor used) in
      let! st = (fun () -> skip input body.state) in
      let! has_else = (fun () -> if kind = 1ul then keyword input st.offset 4ul 0x656c7365uL else ret input (false)) in
      if has_else then
        control_body input { st with offset = plus st.offset 4ul } inner in_function jumps floor body.used
      else ret input ({ body with state = st })
    else if kind = 3ul then
      let! body = (fun () -> control_body input { state with offset = plus state.offset 2ul } inner in_function LoopJump floor used) in
      let! st = (fun () -> skip input body.state) in
      let! tested = (fun () -> keyword input st.offset 5ul 0x7768696c65uL) in
      let! st = (fun () -> if not tested then ret input (failed st 1ul)
        else
          let! st = (fun () -> (let! anf_value_4 = (fun () -> (condition input { st with offset = plus st.offset 5ul } fuel)) in skip input anf_value_4)) in
          (let! anf_value_5 = (fun () -> same input st.offset 59uy) in if anf_value_5 then consume input st 59uy else ret input (st))) in
      ret input ({ body with state = st })
    else
      let! result =
        (fun () -> if kind = 4ul then
          let! tested = (fun () -> for_header input { state with offset = plus state.offset 3ul } allow_var (in_function && state.module_mode) fuel) in
          let! body = (fun () -> control_body input tested inner in_function LoopJump tested.local_names tested.local_names) in
          ret input ({ body.state with local_names = state.local_names })
        else if kind = 5ul then
          try_statement input { state with offset = plus state.offset 3ul } inner in_function jumps used
        else if kind = 6ul then control_block input state inner in_function jumps used used
        else
          let! tested = (fun () -> condition input { state with offset = plus state.offset 6ul } fuel) in
          let! start = (fun () -> (let! anf_value_6 = (fun () -> (skip input tested)) in consume input anf_value_6 123uy)) in
          let case_jumps = if jumps = LoopJump then LoopJump else BreakOnly in
          let! st = (fun () -> switch_sequence input start inner input.size in_function case_jumps used used false false) in
          consume input { st with local_names = state.local_names } 125uy) in
      ret input ({ state = result; used })
and control_body (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 52; 0]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ state = st; used })
  else (let! anf_value_1 = (fun () -> same input st.offset 123uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> control_block input st fuel in_function jumps used used) in ret input ({ state = anf_value_2; used }))
  else control_statement input st fuel in_function jumps floor used false)
and catch_block (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (used:names_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 52; 0]) =
  let! st = (fun () -> skip input state) in
  (let! anf_value_1 = (fun () -> same input st.offset 40uy) in if anf_value_1 then
    let st = record_binding_mode st LexicalLocals in
    let! start = (fun () -> (let! anf_value_2 = (fun () -> (consume input st 40uy)) in skip input anf_value_2)) in
    let! bound = (fun () -> pattern_binding input start binding_region_width used used fuel) in
    let! annotated = (fun () -> (let! anf_value_3 = (fun () -> (simple_annotation input bound.state)) in skip input anf_value_3)) in
    let! body = (fun () -> consume input annotated 41uy) in
    control_block input body fuel in_function jumps used bound.used
  else control_block input st fuel in_function jumps used used)
and try_statement (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (used:names_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 53; 0]) =
  let! after = (fun () -> (let! anf_value_1 = (fun () -> (control_block input state fuel in_function jumps used used)) in skip input anf_value_1)) in
  if after.status <> 0ul then ret input (after)
  else
    let! caught = (fun () -> keyword input after.offset 5ul 0x6361746368uL) in
    let! st = (fun () -> if caught then
      (let! anf_value_2 = (fun () -> (catch_block input { after with offset = plus after.offset 5ul } fuel in_function jumps used)) in skip input anf_value_2)
      else ret input (after)) in
    let! cleanup = (fun () -> keyword input st.offset 7ul 0x66696e616c6c79uL) in
    if cleanup then
      control_block input { st with offset = plus st.offset 7ul } fuel in_function jumps used used
    else ret input (if caught then st
    else failed st 1ul)

and function_parameters (input:tape) (state:parser_state) (floor used:names_used) (fuel remaining:U32.t)
  (non_simple constructor:bool)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 46; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ names = { state = st; used }; non_simple })
  else (let! anf_value_1 = (fun () -> same input st.offset 41uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> consume input st 41uy) in ret input ({ state = anf_value_3; used }))) in ret input ({ names = anf_value_2; non_simple }))
  else if remaining = 0ul then ret input ({ names = { state = failed st 1ul; used }; non_simple })
  else
    let! spread = (fun () -> spread_at input st.offset) in
    let! receiver = (fun () -> if remaining = 64ul then keyword input st.offset 4ul 0x74686973uL else ret input (false)) in
    if receiver then
      let! colon = (fun () -> skip input { st with offset = plus st.offset 4ul }) in
      let! typed = (fun () -> (let! anf_value_4 = (fun () -> (consume input colon 58uy)) in annotation_type input anf_value_4 16ul 64ul)) in
      let! end_ = (fun () -> skip input typed) in
      (let! anf_value_5 = (fun () -> same input end_.offset 44uy) in if anf_value_5 then
        (let! anf_value_6 = (fun () -> (consume input end_ 44uy)) in function_parameters input anf_value_6 floor used fuel (minus remaining 1ul) non_simple constructor)
      else (let! anf_value_7 = (fun () -> (let! anf_value_8 = (fun () -> consume input end_ 41uy) in ret input ({ state = anf_value_8; used }))) in ret input ({ names = anf_value_7; non_simple })))
    else if spread then rest_parameter input st floor used
    else
      let! st = (fun () -> if constructor then constructor_property input st else ret input (st)) in
      let! prefix = (fun () -> parameter_prefix input st floor used fuel) in
      let st = prefix.names.state in
      let! default_ = (fun () -> same input st.offset 61uy) in
      let non_simple = non_simple || prefix.non_simple || default_ in
      let! st =
        (fun () -> if default_ then
          let! start = (fun () -> consume input { st with await_allowed = false; local_names = prefix.names.used } 61uy) in
          let! value = (fun () -> comparison input start fuel) in
          ret input ({ value.parser with await_allowed = st.await_allowed; local_names = st.local_names })
        else ret input (st)) in
      let! end_ = (fun () -> skip input st) in
      (let! anf_value_9 = (fun () -> same input end_.offset 44uy) in if anf_value_9 then
        (let! anf_value_10 = (fun () -> (consume input end_ 44uy)) in function_parameters input anf_value_10 floor prefix.names.used fuel (minus remaining 1ul) non_simple constructor)
      else (let! anf_value_11 = (fun () -> (let! anf_value_12 = (fun () -> consume input end_ 41uy) in ret input ({ prefix.names with state = anf_value_12 }))) in ret input ({ names = anf_value_11; non_simple }))))
and function_tail (input:tape) (state:parser_state) (fuel:U32.t) (async_:bool) (super_:super_context)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 54; 0]) =
  (let! anf_value_1 = (fun () -> (function_form input state fuel async_ super_ false OrdinaryParameters false)) in ret input (anf_value_1.after_function))

and function_form (input:tape) (state:parser_state) (fuel:U32.t) (async_:bool) (super_:super_context) (overload:bool)
  (arity:parameter_arity) (generator:bool)
  : Tot (stt function_shape (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 53; 0]) =
  let depth = minus 64ul fuel in
  let start = if U32.(depth >^ state.depth) then { state with depth } else state in
  let start = { start with super_context = NoSuper; yield_allowed = false } in
  let! start = (fun () -> (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (skip input start)) in optional_type_parameters input anf_value_2))) in skip input anf_value_1)) in
  let! opening = (fun () -> consume input start 40uy) in
  let! opening, limit =
    (fun () -> if arity = OrdinaryParameters then ret input ((opening, 64ul))
    else
      let! first = (fun () -> skip input opening) in
      let! close = (fun () -> same input first.offset 41uy) in
      if arity = GetterParameters then ret input ((first, 0ul))
      else (let! anf_value_3 = (fun () -> (if close then ret input (true) else spread_at input first.offset)) in if anf_value_3 then ret input ((failed first 1ul, 1ul))
      else ret input ((first, 1ul)))) in
  let floor = state.local_names in
  let constructor = super_ = BaseConstructor || super_ = DerivedConstructor in
  let! params = (fun () -> function_parameters input opening floor floor fuel limit false constructor) in
  let! annotation = (fun () -> if constructor then ret input (params.names.state) else result_annotation input params.names.state) in
  let! st = (fun () -> skip input annotation) in
  let! signature_only = (fun () -> if overload && st.status = 0ul then (let! anf_value_4 = (fun () -> (same input st.offset 123uy)) in ret input (not anf_value_4)) else ret input (false)) in
  let! closed =
    (fun () -> if signature_only then
      signature_end input state opening params annotation st
    else
      let st = { st with await_allowed = async_; yield_allowed = generator; in_allowed = true; binding_mode = NoLocals; super_context = super_ } in
      (let! anf_value_5 = (fun () -> (function_body input st params.non_simple)) in control_block input anf_value_5 fuel true NoJump floor params.names.used)) in
  ret input ({ after_function = { closed with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed; in_allowed = state.in_allowed;
      binding_mode = state.binding_mode; super_context = state.super_context }; signature_only })

and class_field_tail (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 55; 0]) =
  let! gap = (fun () -> trivia input state.offset) in
  let st = from_cursor state gap in
  let! byte = (fun () -> peek input st.offset) in
  let definite = byte = 33uy && not gap.newline in
  let optional = byte = 63uy && not gap.newline in
  let! head = (fun () -> if optional || definite then consume input st byte else ret input (state)) in
  let! typed = (fun () -> simple_annotation input head) in
  let! after = (fun () -> skip input typed) in
  let! equal = (fun () -> same input after.offset 61uy) in
  if definite && (equal || typed.offset = head.offset) then ret input (failed after 1ul)
  else if not equal then statement_end input typed typed.offset true
  else
    let! start = (fun () -> consume input { after with await_allowed = false; yield_allowed = false; super_context = ClassField; in_allowed = true } 61uy) in
    let! value = (fun () -> comparison input start fuel) in
    let! closed = (fun () -> statement_end input value.parser value.range.G.last true) in
    ret input ({ closed with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed;
      super_context = state.super_context; in_allowed = state.in_allowed })

and class_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (derived seen_constructor:bool) (pending:pending_overload)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 56; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  let! byte = (fun () -> peek input st.offset) in
  let awaiting_body = pending.key_span.G.first <> pending.key_span.G.last in
  if st.status <> 0ul then ret input (st)
  else if byte = 125uy then
    if awaiting_body then ret input (failed st 1ul) else consume input st 125uy
  else if remaining = 0ul then ret input (failed st 1ul)
  else if byte = 59uy then
    if awaiting_body then ret input (failed st 1ul)
    else (let! anf_value_1 = (fun () -> (consume input st 59uy)) in class_members input anf_value_1 fuel (minus remaining 1ul) derived seen_constructor no_overload)
  else
    let! key = (fun () -> class_member_key input st) in
    let! tail = (fun () -> skip input key.after_key) in
    if tail.status <> 0ul then ret input (tail)
    else
      let! constructor_spelling = (fun () -> wide_key_matches input (if key.private_ then { key with first = next key.first } else key)
        3ul 0x636f6e7374727563uL 0x746f72uL) in
      let constructor_name = not key.private_ && constructor_spelling in
      let constructor = constructor_name && not key.static_ in
      let! prototype = (fun () -> if key.static_ then wide_key_matches input key 1ul 0x70726f746f747970uL 0x65uL else ret input (false)) in
      let! next_byte = (fun () -> peek input tail.offset) in
      let method = next_byte = 40uy || next_byte = 60uy in
      let accessor = key.arity <> OrdinaryParameters in
      let! public_ = (fun () -> if method && U32.logand key.modifier_flags 4ul <> 0ul then keyword input st.offset 6ul 0x7075626c6963uL
        else ret input true) in
      let overload = method && public_ && U32.logand key.modifier_flags 10ul = 0ul &&
        not constructor && not accessor && not key.private_ && not key.quoted_ && not key.generator_ in
      let! compatible = (fun () -> if not awaiting_body then ret input true else
          let length = minus key.last key.first in
          if overload && pending.key_flags = key.modifier_flags && pending.key_async = key.async_ &&
            length = minus pending.key_span.G.last pending.key_span.G.first then
            same_bytes input key.first pending.key_span.G.first length
          else ret input false) in
      if not compatible || (key.private_ && constructor_spelling) || prototype || (constructor_name && not method) || (key.readonly_ && method) ||
        (accessor && (key.async_ || key.generator_ || constructor || next_byte <> 40uy)) ||
        (constructor && (seen_constructor || key.async_ || key.generator_ || next_byte <> 40uy)) then ret input (failed tail 1ul)
      else
        let! tail = (fun () -> if key.private_ then record_private input tail { G.first = key.first; G.last = key.last } PrivateDeclaration
          else ret input tail) in
        let! after, pending =
          (fun () -> if method then
            if fuel = 0ul then ret input (failed tail 3ul, no_overload)
            else
              let mode = if not constructor then MethodSuper else if derived then DerivedConstructor else BaseConstructor in
              let! result = (fun () -> function_form input tail (minus fuel 1ul) key.async_ mode overload key.arity key.generator_) in
              let pending = if result.signature_only then
                { key_span = { G.first = key.first; G.last = key.last }; key_flags = key.modifier_flags; key_async = key.async_ }
                else no_overload in
              ret input (result.after_function, pending)
          else if key.async_ || key.generator_ then ret input (failed tail 1ul, no_overload)
          else let! field = (fun () -> class_field_tail input { tail with offset = key.after_key.offset } fuel) in ret input (field, no_overload)) in
        class_members input after fuel (minus remaining 1ul) derived (seen_constructor || constructor) pending
and class_tail (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 57; 0]) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (skip input state)) in optional_type_parameters input anf_value_2))) in skip input anf_value_1)) in
  let! derived = (fun () -> keyword input st.offset 7ul 0x657874656e6473uL) in
  let! inherited =
    (fun () -> if not derived then ret input (st)
    else
      let! base = (fun () -> skip input { st with offset = plus st.offset 7ul }) in
      let! named = (fun () -> name input base.offset false false) in
      let! forbidden = (fun () -> forbidden_field_arguments input base) in
      if named.ok && not forbidden then (let! anf_value_3 = (fun () -> (type_reference input base 16ul)) in skip input anf_value_3) else ret input (failed base 1ul)) in
  let! word_ = (fun () -> word input inherited.offset 8ul 0uL) in
  let! implements = (fun () -> if word_ = 0x696d706c656d656euL then keyword input (plus inherited.offset 8ul) 2ul 0x7473uL
    else ret input (false)) in
  let! ready = (fun () -> if implements then interface_bases input { inherited with offset = plus inherited.offset 10ul } 64ul else ret input (inherited)) in
  let depth = minus 65ul fuel in
  let ready = if U32.(depth >^ ready.depth) then { ready with depth } else ready in
  let! start = (fun () -> consume input ready 123uy) in
  let! start = (fun () -> if input.private_possible then record_private input start (start_range ready.offset) PrivateScope
    else ret input start) in
  let! closed = (fun () -> class_members input start fuel input.size derived false no_overload) in
  ret input { closed with private_scope = state.private_scope }

and pattern_names (input:tape) (state:parser_state) (base:names_base) (floor used:names_used)
  (fuel depth remaining:U32.t) (close:U8.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 16; U32.v depth; 1; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ state = st; used })
  else (let! anf_value_1 = (fun () -> same input st.offset close) in if anf_value_1 then (let! anf_value_2 = (fun () -> consume input st close) in ret input ({ state = anf_value_2; used }))
  else if remaining = 0ul then ret input ({ state = failed st 1ul; used })
  else
    let! byte = (fun () -> peek input st.offset) in
    if close = 93uy && byte = 44uy then
      (let! anf_value_3 = (fun () -> (consume input st 44uy)) in pattern_names input anf_value_3 base floor used fuel depth (minus remaining 1ul) close)
    else (let! anf_value_4 = (fun () -> spread_at input st.offset) in if anf_value_4 then
      let! target = (fun () -> skip input { st with offset = plus st.offset 3ul }) in
      let! rest = (fun () -> bind_pattern_name input target base floor used target.offset) in
      (let! anf_value_5 = (fun () -> (let! anf_value_6 = (fun () -> (skip input rest.state)) in consume input anf_value_6 close)) in ret input ({ rest with state = anf_value_5 }))
    else
      let! bound =
        (fun () -> if close = 93uy then pattern_binding_at input st base floor used fuel depth
        else
          let! key = (fun () -> if G.decimal_digit byte || byte = 46uy then number_end input st.offset else property_name input st) in
          let! after = (fun () -> skip input (from_cursor st key)) in
          (let! anf_value_7 = (fun () -> same input after.offset 58uy) in if anf_value_7 then
            let! target = (fun () -> (let! anf_value_8 = (fun () -> (consume input after 58uy)) in skip input anf_value_8)) in
            pattern_binding_at input target base floor used fuel depth
          else bind_pattern_name input st base floor used st.offset)) in
      let! equal = (fun () -> skip input bound.state) in
      let! initialized = (fun () -> same input equal.offset 61uy) in
      let! st = (fun () -> if not initialized || equal.status <> 0ul then ret input equal
        else
          let! simple = (fun () -> simple_default input equal) in
          let! delimiter = (fun () -> peek input simple.offset) in
          if simple.status = 0ul && (delimiter = 44uy || delimiter = close) then ret input simple
          else if fuel = 0ul || not equal.arrow_defaults_allowed then ret input (failed equal 1ul)
          else
            let local_names = if base = binding_region_width then bound.used else equal.local_names in
            let! start = (fun () -> consume input { equal with local_names; in_allowed = true; arrow_defaults_allowed = false } 61uy) in
            let! value = (fun () -> comparison input start (minus fuel 1ul)) in
            let! tail = (fun () -> skip input value.parser) in
            let! comma = (fun () -> same input tail.offset 44uy) in
            let end_ = if value.open_angle && comma then failed tail 1ul else tail in
            ret input { end_ with local_names = equal.local_names; in_allowed = equal.in_allowed;
              arrow_defaults_allowed = equal.arrow_defaults_allowed }) in
      (let! anf_value_10 = (fun () -> same input st.offset 44uy) in if anf_value_10 then
        (let! anf_value_11 = (fun () -> (consume input st 44uy)) in pattern_names input anf_value_11 base floor bound.used fuel depth (minus remaining 1ul) close)
      else (let! anf_value_12 = (fun () -> consume input st close) in ret input ({ bound with state = anf_value_12 })))))

and pattern_binding_at (input:tape) (state:parser_state) (base:names_base) (floor used:names_used) (fuel depth:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 16; U32.v depth; 0; 0]) =
  let! byte = (fun () -> peek input state.offset) in
  if byte = 123uy || byte = 91uy then
    if depth = 0ul then ret input ({ state = failed state 1ul; used })
    else
      let close = if byte = 123uy then 125uy else 93uy in
      (let! anf_value_1 = (fun () -> (consume input state byte)) in pattern_names input anf_value_1 base floor used fuel (minus depth 1ul) 64ul close)
  else bind_pattern_name input state base floor used state.offset

and pattern_binding (input:tape) (state:parser_state) (base:names_base) (floor used:names_used) (fuel:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 17; 0]) =
  pattern_binding_at input state base floor used fuel 16ul

and collection_head (input:tape) (state:parser_state) (allow_in local_var:bool) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 18; 0]) =
  let! byte = (fun () -> peek input state.offset) in
  let! constant = (fun () -> if byte = 99uy then keyword input state.offset 5ul 0x636f6e7374uL else ret input (false)) in
  let! lexical = (fun () -> if byte = 108uy then keyword input state.offset 3ul 0x6c6574uL else ret input (false)) in
  let! var = (fun () -> if local_var && byte = 118uy then keyword input state.offset 3ul 0x766172uL else ret input false) in
  let width =
    if constant then 5ul
    else if lexical || var then 3ul
    else 0ul in
  if state.status <> 0ul then ret input state
  else
    let! start = (fun () -> if width = 0ul then ret input state else skip input { state with offset = plus state.offset width }) in
    let! bound = (fun () -> if constant || lexical then
      let mark = state.local_names in
      let! binding = (fun () -> pattern_binding input start binding_region_width mark mark fuel) in
      ret input binding.state
      else let! target = (fun () -> name input start.offset false true) in ret input (from_cursor start target)) in
    let! next_token = (fun () -> skip input bound) in
    let! of_token = (fun () -> keyword input next_token.offset 2ul 0x6f66uL) in
    let! in_token = (fun () -> keyword input next_token.offset 2ul 0x696euL) in
    let! async_target = (fun () -> if allow_in && of_token && width = 0ul && byte = 97uy then
      keyword input start.offset 5ul 0x6173796e63uL else ret input false) in
    if next_token.status <> 0ul || async_target || not (of_token || (allow_in && in_token)) then ret input (failed state 1ul)
    else
      let value = { next_token with offset = plus next_token.offset 2ul } in
      let value = if var then record_binding_mode value VarLocals
        else if local_var && (constant || lexical) then record_binding_mode value LexicalLocals else value in
      ret input value

and parameter_prefix (input:tape) (state:parser_state) (floor used:names_used) (fuel:U32.t)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 18; 0]) =
  let! first = (fun () -> peek input state.offset) in
  let! bound = (fun () -> pattern_binding input { state with await_allowed = false; yield_allowed = false } binding_region_width floor used fuel) in
  let! tail = (fun () -> skip input { bound.state with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed }) in
  let! typed = (fun () -> (let! anf_value_1 = (fun () -> same input tail.offset 63uy) in if anf_value_1 then
      let! colon = (fun () -> (let! anf_value_2 = (fun () -> (consume input tail 63uy)) in skip input anf_value_2)) in
      (let! anf_value_3 = (fun () -> (consume input colon 58uy)) in annotation_type input anf_value_3 16ul 64ul)
    else simple_annotation input tail)) in
  (let! anf_value_4 = (fun () -> (let! anf_value_5 = (fun () -> skip input typed) in ret input ({ bound with state = anf_value_5 }))) in ret input ({ names = anf_value_4; non_simple = first = 123uy || first = 91uy }))

#pop-options

let declaration (input:tape) (state:parser_state) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! has_const = (fun () -> keyword input state.offset 5ul 0x636f6e7374uL) in
  if state.status <> 0ul || not has_const then ret input (failed state 1ul)
  else
    let! st = (fun () -> skip input { state with offset = plus state.offset 5ul }) in
    let! named = (fun () -> name input st.offset false true) in
    let! st = (fun () -> skip input (from_cursor st named)) in
    let! st = (fun () -> consume input st 61uy) in
    (let! anf_value_1 = (fun () -> (comparison input st 64ul)) in ret input (anf_value_1.parser))

let static_import_attributes (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! opening = (fun () -> (let! anf_value_1 = (fun () -> (skip input #frame { state with offset = plus state.offset 4ul })) in consume input #frame anf_value_1 123uy)) in
  let! key = (fun () -> skip input #frame opening) in
  (let! anf_value_2 = (fun () -> same input #frame key.offset 125uy) in if anf_value_2 then consume input #frame key 125uy
  else (let! anf_value_3 = (fun () -> (let! anf_value_4 = (fun () -> (keyword input #frame key.offset 4ul 0x74797065uL)) in read_ret input #frame (not anf_value_4))) in if anf_value_3 then read_ret input #frame (failed key 1ul)
  else
    let! colon = (fun () -> skip input #frame { key with offset = plus key.offset 4ul }) in
    let! value = (fun () -> (let! anf_value_5 = (fun () -> (consume input #frame colon 58uy)) in skip input #frame anf_value_5)) in
    let! delimiter = (fun () -> peek input #frame value.offset) in
    if delimiter <> 34uy && delimiter <> 39uy then read_ret input #frame (failed value 1ul)
    else
      let! literal = (fun () -> string_end input #frame (next value.offset) delimiter input.size false) in
      let! ending = (fun () -> skip input #frame (from_cursor value literal)) in
      let! ending = (fun () -> (let! anf_value_6 = (fun () -> same input #frame ending.offset 44uy) in if anf_value_6 then (let! anf_value_7 = (fun () -> (consume input #frame ending 44uy)) in skip input #frame anf_value_7) else read_ret input #frame (ending))) in
      consume input #frame ending 125uy))

let import_source (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  let! delimiter = (fun () -> peek input #frame st.offset) in
  if st.status <> 0ul || (delimiter <> 34uy && delimiter <> 39uy) then read_ret input #frame (failed st 1ul)
  else
    let! literal = (fun () -> (let! anf_value_1 = (fun () -> (string_end input #frame (next st.offset) delimiter input.size false)) in read_ret input #frame (from_cursor st anf_value_1))) in
    let! tail = (fun () -> skip input #frame literal) in
    let! has_attributes = (fun () -> if tail.status = 0ul then keyword input #frame tail.offset 4ul 0x77697468uL else read_ret input #frame (false)) in
    let! ending = (fun () -> if has_attributes then static_import_attributes input #frame tail else read_ret input #frame (literal)) in
    statement_end input #frame ending ending.offset false

let rec import_members (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t) (allow_type:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ state = st; used })
  else (let! anf_value_1 = (fun () -> same input st.offset 125uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> consume input st 125uy) in ret input ({ state = anf_value_2; used }))
  else
    let! st =
      (fun () -> let! modifier = (fun () -> if allow_type then keyword input st.offset 4ul 0x74797065uL else ret input (false)) in
      if modifier then
        let! after = (fun () -> skip input { st with offset = plus st.offset 4ul }) in
        let! first = (fun () -> peek input after.offset) in
        let! as_ = (fun () -> keyword input after.offset 2ul 0x6173uL) in
        ret input (if G.identifier_start first && not as_ then after else st)
      else ret input (st)) in
    let! first = (fun () -> peek input st.offset) in
    if fuel = 0ul || not (G.identifier_start first) then ret input ({ state = failed st 1ul; used })
    else
      let! imported = (fun () -> scan_class input st.offset G.Identifier) in
      let! tail = (fun () -> skip input { st with offset = imported }) in
      let! local =
        (fun () -> (let! anf_value_3 = (fun () -> keyword input tail.offset 2ul 0x6173uL) in if anf_value_3 then
          let! start = (fun () -> skip input { tail with offset = plus tail.offset 2ul }) in
          bind_at input start 0ul used start.offset
        else bind_at input st 0ul used st.offset)) in
      let! st = (fun () -> skip input local.state) in
      (let! anf_value_4 = (fun () -> same input st.offset 44uy) in if anf_value_4 then
        (let! anf_value_5 = (fun () -> (consume input st 44uy)) in import_members input anf_value_5 local.used (minus fuel 1ul) allow_type)
      else (let! anf_value_6 = (fun () -> consume input st 125uy) in ret input ({ state = anf_value_6; used = local.used }))))

let import_bindings (input:tape) (state:parser_state) (used:names_used) (allow_type:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! st = (fun () -> skip input state) in
  let! byte = (fun () -> peek input st.offset) in
  if st.status <> 0ul then ret input ({ state = st; used })
  else if byte = 123uy then (let! anf_value_1 = (fun () -> (consume input st 123uy)) in import_members input anf_value_1 used 64ul allow_type)
  else if byte = 42uy then
    let! as_ = (fun () -> skip input { st with offset = next st.offset }) in
    (let! anf_value_2 = (fun () -> keyword input as_.offset 2ul 0x6173uL) in if anf_value_2 then
      let! local = (fun () -> skip input { as_ with offset = plus as_.offset 2ul }) in
      bind_at input local 0ul used local.offset
    else ret input ({ state = failed st 1ul; used }))
  else ret input ({ state = failed st 1ul; used })

let import_declaration (input:tape) (state:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! st = (fun () -> skip input { state with offset = plus state.offset 6ul }) in
  let! byte = (fun () -> peek input st.offset) in
  if byte = 34uy || byte = 39uy then (let! anf_value_1 = (fun () -> import_source input st) in ret input ({ state = anf_value_1; used }))
  else
    let! after_type = (fun () -> (let! anf_value_2 = (fun () -> keyword input st.offset 4ul 0x74797065uL) in if anf_value_2 then
      skip input { st with offset = plus st.offset 4ul }
      else ret input (failed st 1ul))) in
    let! type_only =
      (fun () -> if after_type.status <> 0ul then ret input (false)
      else (let! anf_value_3 = (fun () -> same input after_type.offset 44uy) in if anf_value_3 then ret input (false)
      else (let! anf_value_4 = (fun () -> keyword input after_type.offset 4ul 0x66726f6duL) in if anf_value_4 then
        let! source = (fun () -> skip input { after_type with offset = plus after_type.offset 4ul }) in
        let! first = (fun () -> peek input source.offset) in
        ret input (first <> 34uy && first <> 39uy)
      else ret input (true)))) in
    let! members =
      (fun () -> if byte = 123uy || byte = 42uy then import_bindings input st used true
      else if type_only then
        let! first = (fun () -> peek input after_type.offset) in
        if first = 123uy || first = 42uy then import_bindings input after_type used false
        else bind_at input after_type 0ul used after_type.offset
      else
        let! default_ = (fun () -> bind_at input st 0ul used st.offset) in
        let! after = (fun () -> skip input default_.state) in
        (let! anf_value_5 = (fun () -> same input after.offset 44uy) in if anf_value_5 then
          (let! anf_value_6 = (fun () -> (consume input after 44uy)) in import_bindings input anf_value_6 default_.used true)
        else ret input ({ default_ with state = after }))) in
    let! st = (fun () -> skip input members.state) in
    let! result =
      (fun () -> (let! anf_value_7 = (fun () -> keyword input st.offset 4ul 0x66726f6duL) in if anf_value_7 then import_source input { st with offset = plus st.offset 4ul }
      else ret input (failed st 1ul))) in
    ret input ({ members with state = result })

let ambient_variable_width (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! lexical = (fun () -> local_width input #frame start) in
  if lexical <> 0ul then read_ret input #frame (lexical)
  else (let! anf_value_1 = (fun () -> keyword input #frame start 3ul 0x766172uL) in if anf_value_1 then read_ret input #frame (3ul) else read_ret input #frame (0ul))

let ambient_modifier (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame start 7ul 0x6465636c617265uL) in if anf_value_1 then
    let! after = (fun () -> trivia input #frame (plus start 7ul)) in
    let! width = (fun () -> ambient_variable_width input #frame after.at) in
    read_ret input #frame ({ after with ok = after.ok && not after.newline && width <> 0ul })
  else read_ret input #frame ({ at = start; ok = false; newline = false }))

type declaration_head = {
  after_modifiers:parser_state; width:U32.t; async_declaration:bool; ambient_declaration:bool; class_declaration:bool
}

let declaration_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt declaration_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st =
    (fun () -> (let! anf_value_1 = (fun () -> keyword input #frame state.offset 6ul 0x6578706f7274uL) in if anf_value_1 then skip input #frame { state with offset = plus state.offset 6ul }
    else read_ret input #frame (state))) in
  let! async_ = (fun () -> async_function input #frame st.offset) in
  let st = if async_.ok then { st with offset = async_.at } else st in
  let! ambient = (fun () -> ambient_modifier input #frame st.offset) in
  let st = if ambient.ok then { st with offset = ambient.at } else st in
  let! class_ = (fun () -> class_keyword input #frame st.offset) in
  let! width =
    (fun () -> if class_ then read_ret input #frame (5ul)
    else (let! anf_value_2 = (fun () -> keyword input #frame st.offset 8ul 0x66756e6374696f6euL) in if anf_value_2 then read_ret input #frame (8ul)
    else
      let! declared = (fun () -> type_declaration_width input #frame st.offset) in
      if declared <> 0ul then read_ret input #frame (declared)
      else if ambient.ok then ambient_variable_width input #frame st.offset
      else local_width input #frame st.offset)) in
  read_ret input #frame ({ after_modifiers = st; width; async_declaration = async_.ok; ambient_declaration = ambient.ok; class_declaration = class_ })

let module_function (input:tape) (state:parser_state) (used:names_used) (async_ ambient:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! head = (fun () -> read_generator_head input state) in
  let state = if ambient && head.generator then failed head.after_star 1ul else head.after_star in
  let! named = (fun () -> (let! anf_value_1 = (fun () -> (name input state.offset false true)) in ret input (from_cursor state anf_value_1))) in
  let! function_ = (fun () -> function_form input named 64ul async_ NoSuper (not head.generator) OrdinaryParameters head.generator) in
  let after = function_.after_function in
  if after.status <> 0ul then ret input ({ state = after; used })
  else
    let namespace = if function_.signature_only then FunctionSignature else FunctionImplementation in
    let! binding = (fun () -> bind_in_namespace input state 0ul 0ul used state.offset namespace) in
    ret input ({ binding with state = if binding.state.status = 0ul then after else failed after 1ul })

#push-options "--z3rlimit 20"
let rec module_lexical_list (input:tape) (state:parser_state) (used:names_used) (constant:bool) (remaining:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! start = (fun () -> skip input state) in
  if start.status <> 0ul || remaining = 0ul then ret input ({ state = failed start 1ul; used })
  else
    let! first = (fun () -> peek input start.offset) in
    let! decl = (fun () -> pattern_binding input start 0ul 0ul used 64ul) in
    let! value = (fun () -> declarator_value input decl.state 64ul (not constant && G.identifier_start first)) in
    let! tail = (fun () -> skip input value.parser) in
    let! comma = (fun () -> same input tail.offset 44uy) in
    if tail.status <> 0ul then ret input ({ decl with state = tail })
    else if not comma then (let! anf_value_1 = (fun () -> statement_end input value.parser value.range.G.last false) in ret input ({ decl with state = anf_value_1 }))
    else if value.open_angle then ret input ({ decl with state = failed tail 1ul })
    else (let! anf_value_2 = (fun () -> (consume input tail 44uy)) in module_lexical_list input anf_value_2 decl.used constant (minus remaining 1ul))

let rec enum_members (input:tape) (state:parser_state) (remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input (st)
  else (let! anf_value_1 = (fun () -> same input st.offset 125uy) in if anf_value_1 then consume input st 125uy
  else if remaining = 0ul then ret input (failed st 3ul)
  else
    let! key = (fun () -> property_name input st) in
    let! tail = (fun () -> skip input (from_cursor st key)) in
    let! value =
      (fun () -> (let! anf_value_2 = (fun () -> same input tail.offset 61uy) in if anf_value_2 then (let! anf_value_3 = (fun () -> (consume input tail 61uy)) in comparison input anf_value_3 64ul)
      else ret input (empty_range tail))) in
    let! tail = (fun () -> skip input value.parser) in
    if tail.status <> 0ul then ret input (tail)
    else (let! anf_value_4 = (fun () -> same input tail.offset 44uy) in if anf_value_4 then
      if value.open_angle then ret input (failed tail 1ul)
      else (let! anf_value_5 = (fun () -> (consume input tail 44uy)) in enum_members input anf_value_5 (minus remaining 1ul))
    else consume input tail 125uy))

let enum_declaration (input:tape) (state:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! start = (fun () -> skip input { state with offset = plus state.offset 4ul }) in
  let! named = (fun () -> bind_at input start 0ul used start.offset) in
  let! opening = (fun () -> (let! anf_value_1 = (fun () -> (skip input named.state)) in consume input anf_value_1 123uy)) in
  (let! anf_value_2 = (fun () -> enum_members input opening input.size) in ret input ({ named with state = anf_value_2 }))

let interface_tail (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (optional_type_parameters input #frame state)) in skip input #frame anf_value_1)) in
  let! extends = (fun () -> keyword input #frame st.offset 7ul 0x657874656e6473uL) in
  let! st = (fun () -> if extends then interface_bases input #frame { st with offset = plus st.offset 7ul } 64ul else read_ret input #frame (st)) in
  (let! anf_value_2 = (fun () -> (consume input #frame st 123uy)) in object_type input #frame anf_value_2 15ul input.size)

let global_augmentation_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame state.offset 7ul 0x6465636c617265uL) in if anf_value_1 then
    let! global = (fun () -> skip input #frame { state with offset = plus state.offset 7ul }) in
    (let! anf_value_2 = (fun () -> keyword input #frame global.offset 6ul 0x676c6f62616cuL) in if anf_value_2 then
      (let! anf_value_3 = (fun () -> (skip input #frame { global with offset = plus global.offset 6ul })) in consume input #frame anf_value_3 123uy)
    else read_ret input #frame (failed state 1ul))
  else read_ret input #frame (failed state 1ul))

let ambient_module_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame state.offset 7ul 0x6465636c617265uL) in if anf_value_1 then
    let! module_ = (fun () -> skip input #frame { state with offset = plus state.offset 7ul }) in
    (let! anf_value_2 = (fun () -> keyword input #frame module_.offset 6ul 0x6d6f64756c65uL) in if anf_value_2 then
      let! quoted = (fun () -> skip input #frame { module_ with offset = plus module_.offset 6ul }) in
      let! delimiter = (fun () -> peek input #frame quoted.offset) in
      if delimiter = 34uy || delimiter = 39uy then
        let! key = (fun () -> string_end input #frame (next quoted.offset) delimiter input.size false) in
        (let! anf_value_3 = (fun () -> (skip input #frame (from_cursor quoted key))) in consume input #frame anf_value_3 123uy)
      else read_ret input #frame (failed state 1ul)
    else read_ret input #frame (failed state 1ul))
  else read_ret input #frame (failed state 1ul))

let rec ambient_interfaces (input:tape) (#frame:slprop) (state:parser_state) (remaining:U32.t) (allow_exports:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 125uy) in if anf_value_1 then consume input #frame st 125uy
  else if remaining = 0ul then read_ret input #frame (failed st 3ul)
  else
    let! exported = (fun () -> if allow_exports then keyword input #frame st.offset 6ul 0x6578706f7274uL else read_ret input #frame (false)) in
    let! member = (fun () -> if exported then skip input #frame { st with offset = plus st.offset 6ul } else read_ret input #frame (st)) in
    (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> type_declaration_width input #frame member.offset) in read_ret input #frame (anf_value_3 = 9ul))) in if anf_value_2 then
      let! start = (fun () -> skip input #frame { member with offset = plus member.offset 9ul }) in
      let! declared = (fun () -> (let! anf_value_4 = (fun () -> (name input #frame start.offset false true)) in read_ret input #frame (from_cursor start anf_value_4))) in
      let! valid = (fun () -> admissible_type_binding input #frame start.offset declared.offset) in
      let! body = (fun () -> if valid then (let! anf_value_5 = (fun () -> (skip input #frame declared)) in interface_tail input #frame anf_value_5) else read_ret input #frame (failed declared 1ul)) in
      ambient_interfaces input #frame body (minus remaining 1ul) allow_exports
    else read_ret input #frame (failed member 1ul)))

let module_declaration (input:tape) (state:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! head = (fun () -> declaration_start input state) in
  let st = head.after_modifiers in
  let width = head.width in
  let! enumeration = (fun () -> if width = 0ul && not head.ambient_declaration then
    keyword input st.offset 4ul 0x656e756duL else ret input false) in
  if enumeration then enum_declaration input st used
  else if width = 0ul then ret input ({ state = failed st 1ul; used })
  else
    let! start = (fun () -> skip input { st with offset = plus st.offset width }) in
    if width = 8ul then module_function input start used head.async_declaration head.ambient_declaration
    else if (width = 3ul || width = 5ul) && not head.ambient_declaration && not head.class_declaration then
      let! enumeration = (fun () -> if width = 5ul then keyword input start.offset 4ul 0x656e756duL else ret input (false)) in
      if enumeration then enum_declaration input start used
      else module_lexical_list input start used (width = 5ul) input.size
    else
      let type_only = width = 4ul || width = 9ul in
      let! decl =
        (fun () -> if head.class_declaration then bind_at input start 0ul used start.offset
        else bind_in_namespace input start 0ul 0ul used start.offset (if type_only then TypeName else ValueName)) in
      let! st = (fun () -> skip input decl.state) in
      let! result =
        (fun () -> if head.class_declaration then class_tail input st 64ul
        else if type_only then
          let! valid = (fun () -> admissible_type_binding input start.offset decl.state.offset) in
          if not valid then ret input (failed st 1ul)
          else if width = 9ul then interface_tail input st
          else type_alias_tail input st false
        else
          let! annotation = (fun () -> (let! anf_value_1 = (fun () -> (consume input st 58uy)) in annotation_type input anf_value_1 16ul 64ul)) in
          statement_end input annotation annotation.offset false) in
      ret input ({ decl with state = { result with await_allowed = state.await_allowed } })
#pop-options

let reserve_export (input:tape) (state:parser_state) (used:names_used) (first last:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let length = minus last first in
  if state.status <> 0ul then ret input ({ state; used })
  else if used = binding_region_width || length = 0ul || U32.(length >^ 256ul) then
    ret input ({ state = failed state 1ul; used })
  else (let! anf_value_1 = (fun () -> name_seen input export_region_base 0ul used first length BothNames) in if anf_value_1 then
    ret input ({ state = failed state 1ul; used })
  else (let! _ = (fun () -> set_binding input (U32.add export_region_base used) { span = { G.first = first; G.last = last }; namespace = BothNames; owner = 0uy }) in
    ret input ({ state; used = U32.add used 1ul })))

let rec reserve_direct_exports (input:tape) (state:parser_state) (used previous current:names_used)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v current) =
  if state.status <> 0ul || U32.(current <=^ previous) then ret input ({ state; used })
  else
    let index = U32.sub current 1ul in
    let! binding = (fun () -> get_binding input index) in
    let! named = (fun () -> if binding.namespace = TypeName || binding.namespace = FunctionSignature then ret input ({ state; used })
      else reserve_export input state used binding.span.G.first binding.span.G.last) in
    reserve_direct_exports input named.state named.used previous index

let export_identifier (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame state.offset) in
  if G.identifier_start first then (let! anf_value_1 = (fun () -> scan_class input #frame state.offset G.Identifier) in read_ret input #frame ({ state with offset = anf_value_1 }))
  else read_ret input #frame (failed state 1ul)

let star_reexport (input:tape) (state:parser_state) (used:names_used)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! alias = (fun () -> keyword input state.offset 2ul 0x6173uL) in
  let! named = (fun () -> if alias then
    let! start = (fun () -> skip input { state with offset = plus state.offset 2ul }) in
    let! last = (fun () -> export_identifier input start) in
    reserve_export input last used start.offset last.offset
    else ret input { state; used }) in
  let! tail = (fun () -> skip input named.state) in
  let! from_ = (fun () -> keyword input tail.offset 4ul 0x66726f6duL) in
  let! source = (fun () -> if from_ then import_source input { tail with offset = plus tail.offset 4ul }
    else ret input (failed tail 1ul)) in
  ret input { named with state = source }

let rec export_string_name (input:tape) (#frame:slprop) (state:parser_state) (delimiter:U8.t) (remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! byte = (fun () -> peek input #frame state.offset) in
  if byte = delimiter then consume input #frame state delimiter
  else if remaining = 0ul then read_ret input #frame (failed state 1ul)
  else if G.identifier_continue byte || byte = 46uy || byte = 45uy || byte = 32uy then
    export_string_name input #frame { state with offset = next state.offset } delimiter (minus remaining 1ul)
  else read_ret input #frame (failed state 1ul)

type resolved_exports = { named:named_state; locals_known:bool }

let rec reexport_members (input:tape) (state:parser_state) (used locals:names_used) (remaining:U32.t) (locals_known:bool)
  : Tot (stt resolved_exports (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ named = { state = st; used }; locals_known = false })
  else (let! anf_value_1 = (fun () -> same input st.offset 125uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> consume input st 125uy) in ret input ({ state = anf_value_3; used }))) in ret input ({ named = anf_value_2; locals_known }))
  else if remaining = 0ul then ret input ({ named = { state = failed st 1ul; used }; locals_known = false })
  else
    let! first = (fun () -> export_identifier input st) in
    let! tail = (fun () -> skip input first) in
    let! type_ = (fun () -> keyword input st.offset 4ul 0x74797065uL) in
    let! type_alias = (fun () -> if type_ then keyword input tail.offset 2ul 0x6173uL else ret input (false)) in
    let! second = (fun () -> peek input tail.offset) in
    let! source, source_end =
      (fun () -> if type_ && not type_alias && G.identifier_start second then (let! anf_value_4 = (fun () -> export_identifier input tail) in ret input (tail, anf_value_4))
      else ret input (st, first)) in
    let! locals_known =
      (fun () -> if locals_known && source_end.status = 0ul then
        name_seen input 0ul 0ul locals source.offset (minus source_end.offset source.offset) BothNames
      else ret input (false)) in
    let! after_source = (fun () -> skip input source_end) in
    let! as_ = (fun () -> keyword input after_source.offset 2ul 0x6173uL) in
    let! first = (fun () -> if as_ then skip input { after_source with offset = plus after_source.offset 2ul } else ret input (source)) in
    let! delimiter = (fun () -> peek input first.offset) in
    let quoted = as_ && (delimiter = 34uy || delimiter = 39uy) in
    let! last =
      (fun () -> if quoted then (let! anf_value_5 = (fun () -> (consume input first delimiter)) in export_string_name input anf_value_5 delimiter 256ul)
      else if as_ then export_identifier input first
      else ret input (source_end)) in
    let start, stop = if quoted then next first.offset, minus last.offset 1ul else first.offset, last.offset in
    let! named = (fun () -> reserve_export input last used start stop) in
    let! tail = (fun () -> skip input named.state) in
    (let! anf_value_6 = (fun () -> same input tail.offset 44uy) in if anf_value_6 then
      (let! anf_value_7 = (fun () -> (consume input tail 44uy)) in reexport_members input anf_value_7 named.used locals (minus remaining 1ul) locals_known)
    else (let! anf_value_8 = (fun () -> (let! anf_value_9 = (fun () -> consume input tail 125uy) in ret input ({ named with state = anf_value_9 }))) in ret input ({ named = anf_value_8; locals_known }))))

let named_reexport (input:tape) (state:parser_state) (used locals:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! resolved = (fun () -> (let! anf_value_1 = (fun () -> (consume input state 123uy)) in reexport_members input anf_value_1 used locals 64ul true)) in
  let named = resolved.named in
  let! tail = (fun () -> skip input named.state) in
  let! from = (fun () -> keyword input tail.offset 4ul 0x66726f6duL) in
  let! result =
    (fun () -> if from then import_source input { tail with offset = plus tail.offset 4ul }
    else if resolved.locals_known then statement_end input named.state named.state.offset false
    else ret input (failed tail 1ul)) in
  ret input ({ named with state = result })

type export_prefix = { after_export:parser_state; export_kind:U32.t; direct:bool }

let module_export (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt export_prefix (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> peek input #frame state.offset) in
  let! exported = (fun () -> if start = 101uy then keyword input #frame state.offset 6ul 0x6578706f7274uL else read_ret input #frame (false)) in
  if not exported then read_ret input #frame ({ after_export = state; export_kind = 0ul; direct = false })
  else
    let! tail = (fun () -> skip input #frame { state with offset = plus state.offset 6ul }) in
    (let! anf_value_1 = (fun () -> keyword input #frame tail.offset 7ul 0x64656661756c74uL) in if anf_value_1 then
      read_ret input #frame ({ after_export = tail; export_kind = 1ul; direct = false })
    else
      let! type_only = (fun () -> keyword input #frame tail.offset 4ul 0x74797065uL) in
      let! start = (fun () -> if type_only then skip input #frame { tail with offset = plus tail.offset 4ul } else read_ret input #frame (tail)) in
      let! byte = (fun () -> peek input #frame start.offset) in
      if byte = 42uy then (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> (consume input #frame start 42uy)) in skip input #frame anf_value_3)) in read_ret input #frame ({ after_export = anf_value_2; export_kind = 2ul; direct = false }))
      else read_ret input #frame (if byte = 123uy then { after_export = start; export_kind = 3ul; direct = false }
      else { after_export = state; export_kind = 0ul; direct = true }))

let default_declaration (input:tape) (state:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! function_head = (fun () -> function_start input state.offset) in
  (let! anf_value_1 = (fun () -> class_keyword input state.offset) in if anf_value_1 then
    let! start = (fun () -> skip input { state with offset = plus state.offset 5ul }) in
    let! byte = (fun () -> peek input start.offset) in
    let! derives = (fun () -> keyword input start.offset 7ul 0x657874656e6473uL) in
    let! named = (fun () -> if byte = 123uy || byte = 60uy || derives then ret input ({ state = start; used })
      else bind_at input start 0ul used start.offset) in
    (let! anf_value_2 = (fun () -> class_tail input named.state 64ul) in ret input ({ named with state = anf_value_2 }))
  else if function_head.ok then
    let! start = (fun () -> skip input { state with offset = plus function_head.at 8ul }) in
    let! head = (fun () -> read_generator_head input start) in
    let start = head.after_star in
    let! byte = (fun () -> peek input start.offset) in
    let! name = (fun () -> if byte = 40uy || byte = 60uy then ret input ({ state = start; used })
      else bind_in_namespace input start 0ul 0ul used start.offset ValueName) in
    let! form = (fun () -> function_form input name.state 64ul (state.offset <> function_head.at) NoSuper false OrdinaryParameters head.generator) in
    ret input ({ name with state = form.after_function })
  else
    let! value = (fun () -> comparison input state 64ul) in
    (let! anf_value_4 = (fun () -> statement_end input value.parser value.range.G.last false) in ret input ({ state = anf_value_4; used })))

private let module_plain_declaration (input:tape) (st:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! first = (fun () -> peek input st.offset) in
  let! augmentation = (fun () -> if first = 100uy then global_augmentation_start input st else ret input (failed st 1ul)) in
  let! ambient_module = (fun () -> if first = 100uy && augmentation.status <> 0ul then ambient_module_start input st else ret input (failed st 1ul)) in
  let! declared =
    (fun () -> if first = 101uy then
      let! enumeration = (fun () -> keyword input st.offset 4ul 0x656e756duL) in
      if enumeration then ret input true else keyword input st.offset 6ul 0x6578706f7274uL
    else if first = 102uy then keyword input st.offset 8ul 0x66756e6374696f6euL
    else if first = 97uy then (let! anf_value_1 = (fun () -> (async_function input st.offset)) in ret input (anf_value_1.ok))
    else if first = 100uy then (let! anf_value_2 = (fun () -> (ambient_modifier input st.offset)) in ret input (anf_value_2.ok))
    else if first = 99uy then
      let! class_ = (fun () -> class_keyword input st.offset) in
      if class_ then ret input (true) else (let! anf_value_3 = (fun () -> local_width input st.offset) in ret input (anf_value_3 <> 0ul))
    else if first = 105uy || first = 116uy then
      let! width = (fun () -> type_declaration_width input st.offset) in ret input (width <> 0ul)
    else
      let! width = (fun () -> local_width input st.offset) in ret input (width <> 0ul)) in
  if augmentation.status = 0ul then (let! anf_value_4 = (fun () -> ambient_interfaces input augmentation input.size false) in ret input ({ state = anf_value_4; used }))
  else if ambient_module.status = 0ul then (let! anf_value_5 = (fun () -> ambient_interfaces input ambient_module input.size true) in ret input ({ state = anf_value_5; used }))
  else if declared then module_declaration input st used
  else (let! anf_value_6 = (fun () -> (let! anf_value_7 = (fun () -> (control_statement input st 64ul false NoJump 0ul 0ul false)) in ret input (anf_value_7.state))) in ret input ({ state = anf_value_6; used }))

let rec module_sequence (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t) (exports:names_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul || st.offset = input.size then ret input (st)
  else if fuel = 0ul then ret input (failed st 1ul)
  else (let! anf_value_1 = (fun () -> same input st.offset 59uy) in if anf_value_1 then
    (let! anf_value_2 = (fun () -> (consume input st 59uy)) in module_sequence input anf_value_2 used (minus fuel 1ul) exports)
  else
    let! exported = (fun () -> module_export input st) in
    let! decl, exports =
      (fun () -> if not st.module_mode && (exported.direct || exported.export_kind <> 0ul) then
        ret input ({ state = failed st 1ul; used }, exports)
      else if exported.export_kind = 1ul then
        let name = exported.after_export in
        let end_ = plus name.offset 7ul in
        let! reserved = (fun () -> reserve_export input name exports name.offset end_) in
        let! body = (fun () -> skip input { reserved.state with offset = end_ }) in
        (let! anf_value_3 = (fun () -> default_declaration input body used) in ret input (anf_value_3, reserved.used))
      else if exported.export_kind = 2ul then
        let! reexported = (fun () -> star_reexport input exported.after_export exports) in
        ret input ({ state = reexported.state; used }, reexported.used)
      else if exported.export_kind = 3ul then
        let! imported = (fun () -> named_reexport input exported.after_export exports used) in
        ret input ({ state = imported.state; used }, imported.used)
      else (let! anf_value_5 = (fun () -> keyword input st.offset 6ul 0x696d706f7274uL) in if anf_value_5 then
        (let! anf_value_6 = (fun () -> import_expression_start input st) in if anf_value_6 then
          (let! anf_value_7 = (fun () -> (let! anf_value_8 = (fun () -> (let! anf_value_9 = (fun () -> (control_statement input st 64ul false NoJump 0ul 0ul false)) in ret input (anf_value_9.state))) in ret input ({ state = anf_value_8; used }))) in ret input (anf_value_7, exports))
        else if st.module_mode then
          (let! anf_value_10 = (fun () -> import_declaration input st used) in ret input (anf_value_10, exports))
        else ret input ({ state = failed st 1ul; used }, exports))
      else
        (let! anf_value_11 = (fun () -> module_plain_declaration input st used) in ret input (anf_value_11, exports)))) in
    let! reserved = (fun () -> if exported.direct then reserve_direct_exports input decl.state exports used decl.used
      else ret input ({ state = decl.state; used = exports })) in
    module_sequence input reserved.state decl.used (minus fuel 1ul) reserved.used)

private let parse_state (input:tape) (st:parser_state) (module_mode:bool) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if st.status <> 0ul || st.offset = input.size then ret input (st)
  else
    let! first = (fun () -> peek input st.offset) in
    let! control = (fun () -> statement_kind input st.offset) in
    if control <> 0ul then control_sequence input st 64ul input.size false NoJump 0ul 0ul true
    else if first = 118uy then
      (let! anf_value_1 = (fun () -> keyword input st.offset 3ul 0x766172uL) in if anf_value_1 then
        let! initialized = (fun () -> binding input { st with offset = plus st.offset 3ul } 64ul true) in
        let! st = (fun () -> (let! anf_value_2 = (fun () -> (skip input initialized)) in consume input anf_value_2 59uy)) in
        control_sequence input st 64ul input.size false NoJump 0ul 0ul true
      else ret input (failed st 1ul))
    else if first <> 99uy && first <> 101uy then ret input (failed st 1ul)
    else
      let! exported = (fun () -> if first = 101uy then keyword input st.offset 6ul 0x6578706f7274uL else ret input (false)) in
      let! st =
        (fun () -> if exported then
          if module_mode then skip input { st with offset = plus st.offset 6ul }
          else ret input (failed st 1ul)
        else ret input (st)) in
      let! st = (fun () -> declaration input st) in
      let! st = (fun () -> skip input st) in
      let! semicolon = (fun () -> same input st.offset 59uy) in
      if semicolon && st.status = 0ul then skip input { st with offset = next st.offset } else ret input (st)

let initial_state (jsx module_mode:bool) : parser_state = {
  offset = 0ul; count = 0ul; depth = 0ul; status = 0ul; local_names = 0ul;
  await_allowed = module_mode; yield_allowed = false; jsx_allowed = jsx; module_mode; strict_script = false; in_allowed = true; for_initializer = false;
  arrow_defaults_allowed = true; binding_mode = NoLocals; super_context = NoSuper; private_scope = 0uy; private_count = 0uy
}

// Successful results consume the buffer and expose a bounded candidate count.
type parse_result (input:tape) = r:parser_state{
  (r.status = 0ul ==> r.offset = input.size /\ U32.v r.count <= U32.v input.capacity) /\
  (r.status <> 0ul ==> r.count = 0ul)
}

let parse_candidates (input:tape) (jsx module_mode:bool)
  : Tot (stt (parse_result input) (heap input) (fun _ -> heap input)) =
  let! initial = (fun () -> (let! anf_value_1 = (fun () -> (let! anf_value_2 = (fun () -> source_start input) in ret input ({ (initial_state jsx module_mode) with offset = anf_value_2 }))) in skip input anf_value_1)) in
  let! strict_script = (fun () -> if module_mode then ret input false else strict_directive input initial.offset) in
  let initial = { initial with strict_script } in
  let! state = (fun () -> parse_state input initial module_mode) in
  let! state : parser_state =
    (fun () -> if state.status = 1ul || (state.status = 0ul && state.offset <> input.size) then
      let! _ = (fun () -> clear_marks input) in
      let! expanded = (fun () -> module_sequence input initial 0ul input.size 0ul) in
      ret input (if expanded.status = 1ul then state else expanded)
    else ret input (state)) in
  let! private_ok = (fun () -> if state.status = 0ul && state.offset = input.size && state.private_count <> 0uy then
    valid_private_log input state.private_count state.private_count else ret input true) in
  ret #(parse_result input) input (if state.status <> 0ul || state.offset <> input.size || not private_ok then
    { (failed state 1ul) with count = 0ul }
  else if U32.(state.count >^ input.capacity) then
    { (failed state 4ul) with count = 0ul }
  else state)

fn parse (input:tape) (jsx module_mode:bool)
  requires heap input
  returns result:parse_result input
  ensures published input result.count
{
  let result = parse_candidates input jsx module_mode;
  if (result.status = 0ul) {
    let full = certify_prefix input result.count;
    if full { result } else {
      let refused = { (failed result 1ul) with count = 0ul };
      rewrite (published input 0ul) as (published input refused.count);

      refused
    }
  } else {
    unfold heap;
    unfold workspace_ready;
    fold (published input result.count);
    result
  }
}

type lexical_conflict = { first_name:G.span; repeated_name:G.span; checked:U32.t }

let no_conflict () : lexical_conflict = {
  first_name = { G.first = 0ul; G.last = 0ul };
  repeated_name = { G.first = 0ul; G.last = 0ul };
  checked = 0ul
}

let rec previous_lexical_name (input:tape) (used:names_used) (key:G.span)
  : Tot (stt G.span (heap input) (fun _ -> heap input)) (decreases U32.v used) =
  if used = 0ul then ret input (start_range 0ul)
  else
    let index = U32.sub used 1ul in
    let! saved = (fun () -> (let! anf_value_1 = (fun () -> (get_binding input index)) in ret input (anf_value_1.span))) in
    let width = minus key.G.last key.G.first in
    let! equal =
      (fun () -> if width = minus saved.G.last saved.G.first then
        same_bytes input key.G.first saved.G.first width
      else ret input (false)) in
    if equal then ret input (saved) else previous_lexical_name input index key

let lexical_operand (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else
    let! first = (fun () -> peek input #frame st.offset) in
    if G.decimal_digit first then (let! anf_value_1 = (fun () -> (number_end input #frame st.offset)) in read_ret input #frame (from_cursor st anf_value_1))
    else
      let! literal =
        (fun () -> if first = 102uy then ((let! anf_value_2 = (fun () -> keyword input #frame st.offset 5ul 0x66616c7365uL) in if anf_value_2 then read_ret input #frame (5ul) else read_ret input #frame (0ul)))
        else if first = 116uy then ((let! anf_value_3 = (fun () -> keyword input #frame st.offset 4ul 0x74727565uL) in if anf_value_3 then read_ret input #frame (4ul) else read_ret input #frame (0ul)))
        else if first = 110uy then ((let! anf_value_4 = (fun () -> keyword input #frame st.offset 4ul 0x6e756c6cuL) in if anf_value_4 then read_ret input #frame (4ul) else read_ret input #frame (0ul)))
        else read_ret input #frame (0ul)) in
      if literal = 0ul then (let! anf_value_5 = (fun () -> (name input #frame st.offset false false)) in read_ret input #frame (from_cursor st anf_value_5))
      else read_ret input #frame ({ st with offset = plus st.offset literal })

let lexical_declarator_end (input:tape) (#frame:slprop) (named:parser_state) (allows_empty:bool) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame named) in
  let! equal = (fun () -> same input #frame st.offset 61uy) in
  if not equal then
    if allows_empty then statement_end input #frame named named.offset false else read_ret input #frame (failed st 1ul)
  else
    let! left = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame st 61uy)) in lexical_operand input #frame anf_value_1)) in
    let! boundary = (fun () -> skip input #frame left) in
    let! op = (fun () -> operator input #frame boundary.offset true) in
    let! end_ =
      (fun () -> if op.boundary <> 0ul then lexical_operand input #frame { boundary with offset = plus boundary.offset op.width }
      else read_ret input #frame (left)) in
    statement_end input #frame end_ end_.offset false

let rec read_lexical_conflict (input:tape) (state:parser_state) (used:names_used)
  (found:lexical_conflict) (fuel:U32.t)
  : Tot (stt (r:lexical_conflict{r.repeated_name.G.first <> r.repeated_name.G.last ==> r.checked = input.size}) (heap input) (fun _ -> heap input))
    (decreases U32.v fuel) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input (no_conflict ())
  else if st.offset = input.size then ret input ({ found with checked = st.offset })
  else if fuel = 0ul || used = binding_region_width then ret input (no_conflict ())
  else
    let! width = (fun () -> local_width input st.offset) in
    if width = 0ul then ret input (no_conflict ())
    else
      let! start = (fun () -> skip input { st with offset = plus st.offset width }) in
      let! key = (fun () -> (let! anf_value_1 = (fun () -> (name input start.offset false true)) in ret input (from_cursor start anf_value_1))) in
      let span = { G.first = start.offset; G.last = key.offset } in
      let length = minus key.offset start.offset in
      if key.status <> 0ul || U32.(length >^ 256ul) then ret input (no_conflict ())
      else
        let! end_ = (fun () -> lexical_declarator_end input key (width = 3ul)) in
        if end_.status <> 0ul then ret input (no_conflict ())
        else
          let! previous = (fun () -> previous_lexical_name input used span) in
          if previous.G.first = previous.G.last then (let! _ = (fun () -> set_binding input used { span; namespace = ValueName; owner = 0uy }) in
            read_lexical_conflict input end_ (U32.add used 1ul) found (minus fuel 1ul)) else if found.repeated_name.G.first <> found.repeated_name.G.last then ret input (no_conflict ())
          else read_lexical_conflict input end_ used { first_name = previous; repeated_name = span; checked = 0ul }
            (minus fuel 1ul)

type checked_conflict (input:tape) = r:lexical_conflict{
  r.repeated_name.G.first <> r.repeated_name.G.last ==>
  r.checked = input.size /\
  U32.v r.first_name.G.first < U32.v r.first_name.G.last /\
  U32.v r.first_name.G.last <= U32.v r.repeated_name.G.first /\
  U32.v r.repeated_name.G.first < U32.v r.repeated_name.G.last /\
  U32.v r.repeated_name.G.last <= U32.v input.size
}

let lexical_duplicate (input:tape)
  : Tot (stt (checked_conflict input) (heap input) (fun _ -> heap input)) =
  let! conflict = (fun () -> read_lexical_conflict input (initial_state false true) 0ul (no_conflict ()) input.size) in
  ret #(checked_conflict input) input (let first = conflict.first_name in
  let second = conflict.repeated_name in
  if U32.(first.G.first <^ first.G.last && first.G.last <=^ second.G.first &&
    second.G.first <^ second.G.last && second.G.last <=^ input.size) then conflict
  else no_conflict ())
