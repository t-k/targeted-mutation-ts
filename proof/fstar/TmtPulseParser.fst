module TmtPulseParser
#lang-pulse

open Pulse.Lib.Pervasives
open TmtPulseMemory
module U8 = FStar.UInt8
module U16 = FStar.UInt16
module U32 = FStar.UInt32
module U64 = FStar.UInt64
module Cast = FStar.Int.Cast
module G = TmtGrammar
module A = Pulse.Lib.Array.Core
module Seq = FStar.Seq
module Size = FStar.SizeT
module S = TmtPulseScan

let class_code (cls:G.byte_class) : n:U8.t{U8.v n <= 3} =
  match cls with
  | G.Space -> 0uy
  | G.Identifier -> 1uy
  | G.DecimalDigits -> 2uy
  | G.HorizontalSpace -> 3uy

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
  let! first = (fun () -> peek input #frame at) in
  if G.whitespace first || first = 47uy || first = 226uy then
    trivia_from input #frame at false (plus input.size 1ul)
  else read_ret input #frame { at; ok = true; newline = false }

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
  let! starts = (fun () -> if U32.(0ul <^ size && size <=^ 8ul) then
    let! first = (fun () -> peek input #frame at) in
    let high = U64.shift_right expected (U32.mul (U32.sub size 1ul) 8ul) in
    read_ret input #frame (Cast.uint8_to_uint64 first = high)
    else read_ret input #frame true) in
  if not starts then read_ret input #frame false
  else
    let! value = (fun () -> word input #frame at size 0uL) in
    if value <> expected then read_ret input #frame false
    else
      let! following = (fun () -> peek input #frame (plus at size)) in
      read_ret input #frame (not (G.identifier_continue following))

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
  | MixedLocals

let local_log_capacity : U16.t = 512us
let primary_locals : U16.t = 513us
let inactive_locals : U16.t = 514us
let mixed_locals_status : U32.t = 6ul
type local_log_used = n:U16.t{U16.v n <= U16.v local_log_capacity}

type super_context =
  | NoSuper
  | FunctionBody
  | MethodSuper
  | BaseConstructor
  | DerivedConstructor
  | ClassField

type parser_state = {
  offset:U32.t; count:U32.t; depth:U32.t; status:U32.t; local_names:names_used;
  await_allowed:bool; yield_allowed:bool; jsx_allowed:bool; module_mode:bool; strict_script:bool; in_allowed:bool; for_initializer:bool;
  arrow_defaults_allowed:bool; binding_mode:binding_mode; super_context:super_context;
  private_scope:U8.t; private_count:U8.t; local_log_floor:U16.t; local_log_used:local_log_used
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
  | NamedLoop : U32.t -> jump_context
  | NestedNamedLoops : U32.t -> U32.t -> jump_context

let loop_jumps (jumps:jump_context) : jump_context =
  match jumps with
  | NamedLoop _ | NestedNamedLoops _ _ -> jumps
  | _ -> LoopJump

let can_assign (target:assignment_target) : bool = target = Assignable || target = MemberTarget || target = PrivateTarget
let can_assign_expression (target:assignment_target) : bool = can_assign target || target = AssertedTarget
type parsed = { parser:parser_state; range:G.span; open_angle:bool; outer_or:bool; right_shift:bool; shortcut:U32.t; target:assignment_target }
type expression_items = { list_end:parser_state; valid_array_target:bool }
type object_item = { value:parsed; prototype_setter:bool }

let failed (state:parser_state) (error:U32.t) : parser_state =
  if state.status = 0ul then { state with status = error } else state

let record_binding_mode (state:parser_state) (kind:binding_mode) : parser_state =
  if state.binding_mode = NoLocals || state.binding_mode = kind then { state with binding_mode = kind }
  else if state.local_log_floor = primary_locals then failed state mixed_locals_status
  else { state with binding_mode = MixedLocals }

let enter_function_locals (state:parser_state) : parser_state =
  let local_log_floor = if state.local_log_floor = primary_locals then state.local_log_floor
    else state.local_log_used in
  { state with binding_mode = NoLocals; local_log_floor }

let leave_function_locals (state outer:parser_state) : parser_state =
  { state with binding_mode = outer.binding_mode; local_log_floor = outer.local_log_floor; local_log_used = outer.local_log_used;
    strict_script = outer.strict_script }

let strict_locals (state:parser_state) : bool = state.module_mode || state.strict_script

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

// Compiler events share the workspace's verified publication and are disabled in extraction.
let record_compiler_span (input:tape) (state:parser_state) (kind:U32.t) (span context:G.span)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if not (if U32.(kind >=^ 7ul) then input.capture_types else input.capture_jsx) ||
    input.count_only || state.status <> 0ul then ret input state
  else
    let! stored = (fun () -> emit_comparison_in_workspace input state state.count kind span.G.first span context) in
    ret input (if stored.status <> 0ul then stored else { stored with count = next stored.count })

let record_jsx_span (input:tape) (state:parser_state) (kind first last:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let span = { G.first = first; G.last = last } in
  record_compiler_span input state kind span span

let record_contextual_reference (input:tape) (state:parser_state) (start:U32.t) (first:U8.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if not input.capture_types || state.status <> 0ul then ret input state
  else
    let width = minus state.offset start in
    let! contextual = (fun () ->
      if first = 97uy && width = 2ul then keyword input start 2ul 0x6173uL
      else if first = 116uy && width = 4ul then keyword input start 4ul 0x74797065uL
      else if (first = 110uy || first = 115uy) && width = 9ul then
        let expected = if first = 110uy then 0x6e616d6573706163uL else 0x7361746973666965uL in
        let! prefix = (fun () -> word input start 8ul 0uL) in
        if prefix = expected then same input (plus start 8ul) (if first = 110uy then 101uy else 115uy)
        else ret input false
      else ret input false) in
    if contextual then record_jsx_span input state 28ul start state.offset else ret input state

let hex_value (ch:U8.t) : U32.t =
  let n = Cast.uint8_to_uint32 ch in
  if G.decimal_digit ch then U32.sub n 48ul
  else if U8.(ch >=^ 97uy && ch <=^ 102uy) then U32.sub n 87ul
  else if U8.(ch >=^ 65uy && ch <=^ 70uy) then U32.sub n 55ul
  else 16ul

let simple_escape (input:tape) (#frame:slprop) (at:U32.t) (template extended:bool) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! escape = (fun () -> peek input #frame (next at)) in
  let! following = (fun () -> peek input #frame (plus at 2ul)) in
  // In an ordinary string or template a backslash before any other printable ASCII character stands for that
  // character. The exceptions have their own forms: x and u take hex digits, and a digit other than a lone zero is
  // an octal or an invalid escape. A property key, a module specifier and a directive are compared as written,
  // so they keep the short list.
  read_ret input #frame ((escape = 48uy && not (G.decimal_digit following)) ||
    (if extended then U8.(escape >=^ 32uy && escape <^ 127uy) && escape <> 120uy && escape <> 117uy && not (G.decimal_digit escape)
    else escape = 92uy || escape = 34uy || escape = 39uy || escape = 110uy || escape = 114uy || escape = 116uy || escape = 98uy ||
      escape = 102uy || escape = 118uy || escape = 96uy || (template && escape = 36uy)))

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
  (let! anf_value_1 = (fun () -> simple_escape input #frame at template extended) in if anf_value_1 then read_ret input #frame ({ at = plus at 2ul; ok = true; newline = false })
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

let no_character : U32.t = 0x110000ul

type regex_unit = { unit_end:U32.t; unit_ok:bool; character:U32.t; repeatable:bool; unicode_only:bool }

let invalid_regex_unit (at:U32.t) : regex_unit =
  { unit_end = at; unit_ok = false; character = no_character; repeatable = false; unicode_only = false }

let rec regex_codepoint (input:tape) (#frame:slprop) (at value fuel:U32.t) (seen:bool)
  : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(value >=^ no_character) then read_ret input #frame (invalid_regex_unit at)
  else
    let! byte = (fun () -> peek input #frame at) in
    if byte = 125uy && seen && U32.(value <^ 55296ul || value >^ 57343ul) then
      read_ret input #frame { unit_end = next at; unit_ok = true; character = value; repeatable = true; unicode_only = true }
    else
      let digit = hex_value byte in
      if digit = 16ul then read_ret input #frame (invalid_regex_unit at)
      else regex_codepoint input #frame (next at) (U32.add (U32.mul value 16ul) digit) (minus fuel 1ul) true

let regex_category (input:tape) (#frame:slprop) (at opening:U32.t)
  : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! brace = (fun () -> same input #frame opening 123uy) in
  let! first = (fun () -> peek input #frame (next opening)) in
  let! second = (fun () -> peek input #frame (plus opening 2ul)) in
  let letter = first = 76uy && second = 125uy in
  let! pair = (fun () -> if (first = 77uy && (second = 99uy || second = 101uy || second = 110uy)) ||
      (first = 76uy && second = 117uy) then
    same input #frame (plus opening 3ul) 125uy else read_ret input #frame false) in
  let! width = (fun () -> if letter then read_ret input #frame 3ul
    else if pair then read_ret input #frame 4ul
    else if first <> 73uy then read_ret input #frame 0ul
    else
      let! word_ = (fun () -> word input #frame (next opening) 8ul 0uL) in
      if word_ = 0x49445f5374617274uL then
        let! end_ = (fun () -> same input #frame (plus opening 9ul) 125uy) in
        read_ret input #frame (if end_ then 10ul else 0ul)
      else if word_ = 0x49445f436f6e7469uL then
        let! end_ = (fun () -> word input #frame (plus opening 9ul) 4ul 0uL) in
        read_ret input #frame (if end_ = 0x6e75657duL then 13ul else 0ul)
      else read_ret input #frame 0ul) in
  read_ret input #frame (if brace && width <> 0ul then
    { unit_end = plus opening width; unit_ok = true; character = no_character; repeatable = true; unicode_only = true }
  else invalid_regex_unit at)

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
  if escape = 112uy || escape = 80uy then regex_category input #frame at finish
  else if escape = 120uy then
    let! anf_value_1 = (fun () -> peek input #frame finish) in
    let high = hex_value anf_value_1 in
    let! anf_value_2 = (fun () -> peek input #frame (next finish)) in
    let low = hex_value anf_value_2 in
    read_ret input #frame (if high = 16ul || low = 16ul then invalid_regex_unit at
    else { unit_end = plus at 4ul; unit_ok = true;
      character = U32.add (U32.mul high 16ul) low; repeatable = true; unicode_only = false })
  else if escape = 117uy then
    let! braced = (fun () -> same input #frame finish 123uy) in
    if braced then regex_codepoint input #frame (next finish) 0ul input.size false else
    let! anf_value_3 = (fun () -> peek input #frame finish) in
    let a = hex_value anf_value_3 in
    let! anf_value_4 = (fun () -> peek input #frame (plus finish 1ul)) in
    let b = hex_value anf_value_4 in
    let! anf_value_5 = (fun () -> peek input #frame (plus finish 2ul)) in
    let c = hex_value anf_value_5 in
    let! anf_value_6 = (fun () -> peek input #frame (plus finish 3ul)) in
    let d = hex_value anf_value_6 in
    let value = U32.(logor (logor (shift_left a 12ul) (shift_left b 8ul)) (logor (shift_left c 4ul) d)) in
    let scalar = U32.(value <^ 55296ul || value >^ 57343ul) in
    let after = plus at 6ul in
    // In Unicode mode, adjacent fixed-width escapes can form one class endpoint.
    let! separate = (fun () ->
      if scalar || not in_class then read_ret input #frame false
      else if U32.(value >=^ 56320ul) then read_ret input #frame true
      else
        let! backslash = (fun () -> same input #frame after 92uy) in
        if not backslash then read_ret input #frame true
        else let! unicode = (fun () -> same input #frame (next after) 117uy) in read_ret input #frame (not unicode)) in
    let valid = a <> 16ul && b <> 16ul && c <> 16ul && d <> 16ul && (scalar || separate) in
    read_ret input #frame { unit_end = after; unit_ok = valid;
      character = if valid then value else no_character; repeatable = valid; unicode_only = false }
  else
    read_ret input #frame (let group = escape = 115uy || escape = 83uy || escape = 100uy || escape = 68uy || escape = 119uy || escape = 87uy in
    let boundary = not in_class && (escape = 98uy || escape = 66uy) in
    { unit_end = finish; unit_ok = character <> no_character || group || boundary;
      character; repeatable = not boundary; unicode_only = false })

let utf8_tail (ch:U8.t) : bool = U8.(ch >=^ 128uy && ch <^ 192uy)

let utf8_bits (byte:U8.t) (mask:U32.t) : U32.t = U32.logand (Cast.uint8_to_uint32 byte) mask

let regex_bmp_unit (input:tape) (#frame:slprop) (at:U32.t) (first:U8.t)
  : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let invalid = invalid_regex_unit at in
  if U8.(first <^ 194uy || first >=^ 240uy) then read_ret input #frame invalid
  else
    let! second = (fun () -> peek input #frame (next at)) in
    if not (utf8_tail second) then read_ret input #frame invalid
    else if U8.(first <^ 224uy) then
      let value = U32.logor (U32.shift_left (utf8_bits first 31ul) 6ul) (utf8_bits second 63ul) in
      read_ret input #frame { unit_end = plus at 2ul; unit_ok = true; character = value; repeatable = true; unicode_only = false }
    else
      let! third = (fun () -> peek input #frame (plus at 2ul)) in
      let value = U32.logor (U32.shift_left (utf8_bits first 15ul) 12ul)
        (U32.logor (U32.shift_left (utf8_bits second 63ul) 6ul) (utf8_bits third 63ul)) in
      if utf8_tail third && U32.(value >=^ 2048ul && (value <^ 55296ul || value >^ 57343ul)) &&
        value <> 8232ul && value <> 8233ul then
        read_ret input #frame { unit_end = plus at 3ul; unit_ok = true; character = value; repeatable = true; unicode_only = false }
      else read_ret input #frame invalid

// A character outside the Basic Multilingual Plane as a pattern character of its own. With the u flag it is one
// character, without it two code units; both read it where it stands. Inside a class the two readings order
// ranges differently, so a class with such a character is left to TypeScript.
let regex_astral_unit (input:tape) (#frame:slprop) (at:U32.t) (first:U8.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! second = (fun () -> peek input #frame (next at)) in
  let! third = (fun () -> peek input #frame (plus at 2ul)) in
  let! fourth = (fun () -> peek input #frame (plus at 3ul)) in
  let value = U32.logor (U32.shift_left (utf8_bits first 7ul) 18ul)
    (U32.logor (U32.shift_left (utf8_bits second 63ul) 12ul)
      (U32.logor (U32.shift_left (utf8_bits third 63ul) 6ul) (utf8_bits fourth 63ul))) in
  read_ret input #frame { at = plus at 4ul; newline = false;
    ok = U8.(first >=^ 240uy && first <=^ 244uy) && utf8_tail second && utf8_tail third && utf8_tail fourth &&
      U32.(value >=^ 65536ul && value <=^ 1114111ul) }

// Without the u or v flag a backslash before one of these characters stands for the character itself.
// The pattern is then valid only without those flags.
let legacy_identity_escape (byte:U8.t) : bool =
  byte = 33uy || byte = 34uy || byte = 35uy || byte = 37uy || byte = 38uy || byte = 39uy || byte = 44uy || byte = 45uy ||
  byte = 58uy || byte = 59uy || byte = 60uy || byte = 61uy || byte = 62uy || byte = 64uy || byte = 95uy || byte = 96uy || byte = 126uy

let regex_class_unit (input:tape) (#frame:slprop) (at:U32.t) : Tot (stt regex_unit (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame at) in
  if byte = 92uy then regex_escape input #frame at true
  else if not (U8.lt byte 128uy) then regex_bmp_unit input #frame at byte
  else read_ret input #frame ({ unit_end = next at; unit_ok = regex_printable byte && byte <> 93uy;
    character = Cast.uint8_to_uint32 byte; repeatable = true; unicode_only = false })

type regex_class_end = { ending:cursor; class_unicode:bool; class_legacy:bool }

let rec regex_class (input:tape) (#frame:slprop) (at fuel:U32.t) (unicode_only legacy:bool)
  : Tot (stt regex_class_end (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let invalid = { ending = { at; ok = false; newline = false }; class_unicode = unicode_only; class_legacy = legacy } in
  if fuel = 0ul then read_ret input #frame invalid
  else (let! anf_value_1 = (fun () -> same input #frame at 93uy) in if anf_value_1 then
    read_ret input #frame ({ invalid with ending = { at = next at; ok = true; newline = false } })
  else
    let! backslash = (fun () -> same input #frame at 92uy) in
    let! escaped = (fun () -> if backslash then peek input #frame (next at) else read_ret input #frame 0uy) in
    let! after = (fun () -> peek input #frame (plus at 2ul)) in
    let! closing = (fun () -> peek input #frame (plus at 3ul)) in
    // A legacy identity escape is taken as a single member. As the start of a range it is left to the reference parser.
    if backslash && escaped <> 45uy && legacy_identity_escape escaped then
      if after = 45uy && closing <> 93uy then read_ret input #frame invalid
      else regex_class input #frame (plus at 2ul) (minus fuel 1ul) unicode_only true
    else
    let! lhs = (fun () -> regex_class_unit input #frame at) in
    if not lhs.unit_ok then read_ret input #frame invalid
    else
      let! dash = (fun () -> same input #frame lhs.unit_end 45uy) in
      let! close = (fun () -> same input #frame (next lhs.unit_end) 93uy) in
      if dash && not close then
        let! rhs = (fun () -> regex_class_unit input #frame (next lhs.unit_end)) in
        let unicode = lhs.unicode_only || rhs.unicode_only in
        let class_range = lhs.character = no_character || rhs.character = no_character in
        if not rhs.unit_ok then read_ret input #frame invalid
        else if class_range then
          if unicode then read_ret input #frame invalid
          else regex_class input #frame rhs.unit_end (minus fuel 1ul) unicode_only true
        else if U32.(lhs.character <=^ rhs.character) then
          regex_class input #frame rhs.unit_end (minus fuel 1ul) (unicode_only || unicode) legacy
        else read_ret input #frame invalid
      else regex_class input #frame lhs.unit_end (minus fuel 1ul) (unicode_only || lhs.unicode_only) legacy)

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

let rec regex_flags (input:tape) (#frame:slprop) (at seen fuel:U32.t) (legacy unicode_only:bool) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let! byte = (fun () -> peek input #frame at) in
  let bit = regex_flag_bit byte in
  if bit = 0ul then read_ret input #frame ({ at; ok = not (G.identifier_continue byte || byte = 92uy) &&
    (not unicode_only || U32.logand seen 32ul <> 0ul); newline = false })
  else if fuel = 0ul || U32.logand bit seen <> 0ul || (legacy && bit = 32ul) then read_ret input #frame ({ at; ok = false; newline = false })
  else regex_flags input #frame (next at) (U32.logor bit seen) (minus fuel 1ul) legacy unicode_only

type regex_captures = { names:U64.t; count:U32.t; legacy:bool; unicode_only:bool }
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
      let! ending = (fun () -> regex_flags input #frame (next at) 0ul 7ul captures.legacy captures.unicode_only) in read_ret input #frame ({ ending; captures })
    else if byte = 41uy && nested then read_ret input #frame (regex_result_at (next at) true captures)
    else if byte = 40uy then
      let! group = (fun () -> regex_group input #frame at depth rest captures) in
      let parsed = group.pattern in
      if not parsed.ending.ok then read_ret input #frame (parsed)
      else regex_pattern input #frame parsed.ending.at depth rest nested group.repeatable_group parsed.captures
    else if byte = 91uy then
      let! negated = (fun () -> same input #frame (next at) 94uy) in
      let! class_ = (fun () -> regex_class input #frame (plus at (if negated then 2ul else 1ul)) rest captures.unicode_only captures.legacy) in
      if not class_.ending.ok then read_ret input #frame ({ ending = class_.ending; captures })
      else regex_pattern input #frame class_.ending.at depth rest nested true
        { captures with unicode_only = class_.class_unicode; legacy = class_.class_legacy }
    else if byte = 92uy then
      let! first = (fun () -> peek input #frame (next at)) in
      if U8.(first >=^ 49uy && first <=^ 57uy) then
        let! index = (fun () -> regex_decimal input #frame (next at) 0ul 6ul) in
        if index.count_ok && U32.(index.count_value <=^ captures.count) then
          regex_pattern input #frame index.count_end depth rest nested true captures
        else read_ret input #frame (regex_result_at at false captures)
      else if legacy_identity_escape first then
        regex_pattern input #frame (plus at 2ul) depth rest nested true { captures with legacy = true }
      else
        let! escaped = (fun () -> regex_escape input #frame at false) in
        if not escaped.unit_ok then read_ret input #frame (regex_result_at at false captures)
        else regex_pattern input #frame escaped.unit_end depth rest nested escaped.repeatable
          { captures with unicode_only = captures.unicode_only || escaped.unicode_only }
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
    else if regex_printable byte && byte <> 47uy && byte <> 41uy then
      let captures = if byte = 125uy || byte = 93uy then { captures with legacy = true } else captures in
      regex_pattern input #frame (next at) depth rest nested true captures
    else if not (U8.lt byte 128uy) then
      let! atom = (fun () -> regex_bmp_unit input #frame at byte) in
      if atom.unit_ok then regex_pattern input #frame atom.unit_end depth rest nested true captures
      else
        let! astral = (fun () -> if not (U8.lt byte 240uy) then regex_astral_unit input #frame at byte
          else read_ret input #frame { at; ok = false; newline = false }) in
        if astral.ok then regex_pattern input #frame astral.at depth rest nested true captures
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
  let! parsed = (fun () -> regex_pattern input #frame at 32ul input.size false false { names = 0uL; count = 0ul; legacy = false; unicode_only = false }) in
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

let is_interface_binding (namespace:binding_namespace) : bool =
  namespace = InterfaceName || namespace = ExportedInterfaceName

let is_class_binding (namespace:binding_namespace) : bool =
  namespace = ClassName || namespace = AmbientClassName

let names_overlap (left right:binding_namespace) : bool =
  if left = RuntimeExport then right = ValueName || right = BothNames || right = FunctionImplementation || right = ClassName
  else if is_function_binding left && is_function_binding right then
    left = FunctionImplementation && right = FunctionImplementation
  // Interfaces of one name merge, whatever they extend and whether or not they are exported.
  else if is_interface_binding left && is_interface_binding right then false
  // An interface and a class of one name merge into the class.
  else if (is_interface_binding left && is_class_binding right) || (is_class_binding left && is_interface_binding right) then false
  else if left = TypeNamespace || right = TypeNamespace then
    // A namespace of types emits nothing and merges with any local declaration of its name.
    // An import or an enum of that name still conflicts, and a lookup by BothNames still finds it.
    let other = if left = TypeNamespace then right else left in
    other = BothNames || other = TypeOnlyImport || other = AmbientBothNames
  else
    let effective binding = if is_function_binding binding || binding = AmbientValueName then ValueName
      else if is_interface_binding binding then TypeName
      else if binding = TypeOnlyImport || binding = AmbientBothNames || is_class_binding binding then BothNames else binding in
    let left = effective left in
    let right = effective right in
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
    ret input (let status = if base = 0ul && (namespace = ValueName || namespace = AmbientValueName) then 5ul else 1ul in
    { state = failed st status; used })
  else (let! _ = (fun () -> set_binding input (U32.add base used) { span = { G.first = pos; G.last = st.offset }; namespace; owner = 0uy }) in
    ret input ({ state = st; used = U32.add used 1ul })))

let bind_since (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) = bind_in_namespace input st base floor used pos BothNames

let bind_pattern_name (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! bound = (fun () -> bind_in_namespace input st base floor used pos ValueName) in
  if not input.capture_types || bound.state.status <> 0ul then ret input bound
  else
    // A declared name such as `as` is an ordinary identifier for the projection guard.
    let! first = (fun () -> peek input pos) in
    let! recorded = (fun () -> record_contextual_reference input bound.state pos first) in
    ret input { bound with state = recorded }

let bind_at (input:tape) (st:parser_state) (base:names_base) (used:names_used) (pos:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) = bind_since input st base 0ul used pos

let local_slot (index:U16.t{U16.v index < U16.v local_log_capacity})
  : at:U32.t{U32.v at < U32.v binding_capacity} =
  U32.add local_region_base (Cast.uint16_to_uint32 index)

let rec local_var_seen (input:tape) (floor:U16.t) (used:local_log_used) (span:G.span)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U16.v used) =
  if U16.(used <=^ floor) then ret input false
  else
    let previous = U16.sub used 1us in
    let! saved = (fun () -> get_binding input (local_slot previous)) in
    let length = minus span.G.last span.G.first in
    let! equal = (fun () -> if saved.namespace = LocalVarName && length = minus saved.span.G.last saved.span.G.first then
      same_bytes input span.G.first saved.span.G.first length else ret input false) in
    if equal then ret input true else local_var_seen input floor previous span

let rec local_scope_conflict (input:tape) (first limit index:local_log_used)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U16.v index) =
  if U16.(index <=^ first) then ret input false
  else
    let previous = U16.sub index 1us in
    let! entry = (fun () -> get_binding input (local_slot previous)) in
    let! conflict = (fun () -> if entry.namespace = LocalLexicalName then local_var_seen input first limit entry.span
      else ret input false) in
    if conflict then ret input true else local_scope_conflict input first limit previous

let rec retain_local_vars (input:tape) (limit read_at:local_log_used)
  (write_at:local_log_used{U16.v write_at <= U16.v read_at})
  : Tot (stt local_log_used (heap input) (fun _ -> heap input)) (decreases (U16.v limit - U16.v read_at)) =
  if U16.(read_at >=^ limit) then ret #local_log_used input write_at
  else
    let! entry = (fun () -> get_binding input (local_slot read_at)) in
    let next_read:local_log_used = U16.add read_at 1us in
    if entry.namespace <> LocalVarName then retain_local_vars input limit next_read write_at
    else
      let! _ = (fun () -> if read_at = write_at then ret input () else set_binding input (local_slot write_at) entry) in
      retain_local_vars input limit next_read (U16.add write_at 1us)

// A block's suffix contains its own lexical declarations and all descendant var names.
// The parent sees the vars in source order after the block-local names have been checked.
let finish_local_scope (input:tape) (state:parser_state) (first:local_log_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if state.status <> 0ul || U16.(state.local_log_floor >^ local_log_capacity) then ret input state
  else if U16.(first <^ state.local_log_floor || first >^ state.local_log_used) then ret input (failed state 1ul)
  else if first = state.local_log_used then ret input state
  else
    let! conflict = (fun () -> if state.binding_mode = MixedLocals then
      local_scope_conflict input first state.local_log_used state.local_log_used else ret input false) in
    if conflict then ret input (failed state 1ul)
    else
      let! kept = (fun () -> retain_local_vars input state.local_log_used first first) in
      ret input { state with local_log_used = kept }

let record_local (input:tape) (st:parser_state) (span:G.span) (namespace:binding_namespace)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if st.status <> 0ul || U16.(st.local_log_floor >^ local_log_capacity) then ret input st
  else if st.local_log_used = local_log_capacity || U32.(minus span.G.last span.G.first >^ 256ul) then ret input (failed st 1ul)
  else
    let! _ = (fun () -> set_binding input (local_slot st.local_log_used) { span; namespace; owner = 0uy }) in
    ret input { st with local_log_used = U16.add st.local_log_used 1us }

let rec record_local_pattern_kind (input:tape) (st:parser_state) (first used:names_used) (kind:binding_namespace)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases (U32.v used - U32.v first)) =
  if st.status <> 0ul || U16.(st.local_log_floor >^ local_log_capacity) || U32.(first >=^ used) then ret input st
  else
    let! entry = (fun () -> get_binding input (U32.add binding_region_width first)) in
    let! tracked = (fun () -> record_local input st entry.span kind) in
    record_local_pattern_kind input tracked (U32.add first 1ul) used kind

let record_local_pattern (input:tape) (st:parser_state) (first used:names_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  record_local_pattern_kind input st first used LocalLexicalName

let read_local_var_name (input:tape) (st:parser_state) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! named = (fun () -> name input st.offset false true) in
  record_local input (from_cursor st named) { G.first = st.offset; G.last = named.at } LocalVarName

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
  packed = 0x6e756c6cuL || packed = 0x74727565uL || packed = 0x66616c7365uL ||
  packed = 0x74686973uL

let type_name (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! width =
    (fun () -> (let! anf_value_1 = (fun () -> keyword input #frame state.offset 4ul 0x766f6964uL) in if anf_value_1 then read_ret input #frame (4ul)
    else (let! anf_value_2 = (fun () -> keyword input #frame state.offset 4ul 0x6e756c6cuL) in if anf_value_2 then read_ret input #frame (4ul)
    else (let! anf_value_3 = (fun () -> keyword input #frame state.offset 4ul 0x74727565uL) in if anf_value_3 then read_ret input #frame (4ul)
    else (let! anf_value_4 = (fun () -> keyword input #frame state.offset 5ul 0x66616c7365uL) in if anf_value_4 then read_ret input #frame (5ul)
    else (let! anf_value_5 = (fun () -> keyword input #frame state.offset 5ul 0x636f6e7374uL) in if anf_value_5 then read_ret input #frame (5ul)
    else (let! this_ = (fun () -> keyword input #frame state.offset 4ul 0x74686973uL) in
    read_ret input #frame (if this_ then 4ul else 0ul)))))))) in
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

let rec non_ascii_property_tail (input:tape) (#frame:slprop) (tail:cursor) (delimiter:U8.t) (fuel:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if tail.ok || fuel = 0ul then read_ret input #frame tail
  else
    let! slash = (fun () -> same input #frame tail.at 92uy) in
    let! unicode = (fun () -> if slash then same input #frame (next tail.at) 117uy else read_ret input #frame false) in
    if not unicode then read_ret input #frame tail
    else
      let start = plus tail.at 2ul in
      let! first = (fun () -> peek input #frame start) in
      let! second = (fun () -> peek input #frame (next start)) in
      let! third = (fun () -> peek input #frame (plus start 2ul)) in
      let high = hex_value first in
      let low = hex_value second in
      let next_nibble = hex_value third in
      // An escaped ASCII key could hide an early error involving a special name.
      if high = 16ul || low = 16ul || next_nibble = 16ul ||
        (high = 0ul && low = 0ul && U32.(next_nibble <^ 8ul)) then read_ret input #frame tail
      else
        let! escape = (fun () -> fixed_hex input #frame (plus start 3ul) 1ul) in
        if not escape.ok then read_ret input #frame tail
        else
          let! rest = (fun () -> string_end input #frame escape.at delimiter input.size false) in
          non_ascii_property_tail input #frame rest delimiter (minus fuel 1ul)

let property_name (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame state.offset) in
  if byte = 34uy || byte = 39uy then
    let! key = (fun () -> string_end input #frame (next state.offset) byte input.size false) in
    if key.ok then read_ret input #frame key else non_ascii_property_tail input #frame key byte 64ul
  else if G.identifier_start byte then
    (let! anf_value_1 = (fun () -> scan_class input #frame state.offset G.Identifier) in read_ret input #frame ({ at = anf_value_1; ok = true; newline = false }))
  else read_ret input #frame ({ at = state.offset; ok = false; newline = false })

let decimal_property_name (input:tape) (#frame:slprop) (at:U32.t) (first:U8.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! end_ = (fun () -> scan_class input #frame at G.DecimalDigits) in
  let! following = (fun () -> peek input #frame end_) in
  let valid = (first <> 48uy || end_ = next at) && not (G.identifier_continue following) in
  read_ret input #frame { at = end_; ok = valid; newline = false }

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
    let! this_ = (fun () -> keyword input #frame target.offset 4ul 0x74686973uL) in
    let! named = (fun () -> if this_ then read_ret input #frame { target with offset = plus target.offset 4ul }
      else (let! anf_value_3 = (fun () -> name input #frame target.offset false false) in read_ret input #frame (from_cursor target anf_value_3))) in
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
let rec signature_prefix_contains (input:tape) (#frame:slprop) (at remaining first length:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  if U32.(remaining <^ length) || remaining = 0ul then read_ret input #frame false
  else
    let! matched = (fun () -> same_bytes input #frame at first length) in
    if matched then read_ret input #frame true
    else signature_prefix_contains input #frame (next at) (minus remaining 1ul) first length

let rec signature_shorthand_names (input:tape) (#frame:slprop) (key:parser_state) (origin remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let prior = minus key.offset origin in
  if key.status <> 0ul || remaining = 0ul || U32.(prior >^ 4096ul) then read_ret input #frame (failed key 1ul)
  else
    let! named = (fun () -> name input #frame key.offset false true) in
    let width = minus named.at key.offset in
    if not named.ok || U32.(width >^ 256ul) then read_ret input #frame (failed key 1ul)
    else
      let! duplicate = (fun () -> signature_prefix_contains input #frame origin prior key.offset width) in
      if duplicate then read_ret input #frame (failed key 1ul)
      else
        let! tail = (fun () -> skip input #frame (from_cursor key named)) in
        let! comma = (fun () -> same input #frame tail.offset 44uy) in
        let! following = (fun () -> if comma then skip input #frame { tail with offset = next tail.offset } else read_ret input #frame tail) in
        let! closes = (fun () -> same input #frame following.offset 125uy) in
        if comma && not closes then signature_shorthand_names input #frame following origin (minus remaining 1ul)
        else consume input #frame following 125uy

type signature_names = { low_bits:U64.t; middle_bits:U64.t; high_bits:U64.t }

let empty_signature_names : signature_names = { low_bits = 0uL; middle_bits = 0uL; high_bits = 0uL }

let signature_name_bit (word_:U64.t) : U64.t =
  let lane = Cast.uint64_to_uint32 (U64.logand word_ 63uL) in
  if U32.(lane <^ 64ul) then U64.shift_left 1uL lane else 0uL

let mark_signature_name (input:tape) (#frame:slprop) (names:signature_names) (first last:U32.t)
  : Tot (stt (signature_names & bool) (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let width = minus last first in
  let wide = U32.(width >^ 8ul) in
  let! prefix = (fun () -> word input #frame first (if wide then 8ul else width) 0uL) in
  let! suffix = (fun () -> if wide then word input #frame (minus last 8ul) 8ul 0uL else read_ret input #frame 0uL) in
  let bits = U64.logxor prefix (U64.logxor (U64.shift_left suffix 13ul) (Cast.uint32_to_uint64 width)) in
  let hash = U64.mul_mod (U64.logxor bits (U64.shift_right bits 23ul)) 0x9e3779b185ebca87uL in
  let low = signature_name_bit hash in
  let middle = signature_name_bit (U64.shift_right hash 28ul) in
  let high = signature_name_bit (U64.shift_right hash 41ul) in
  let collision = U64.logand names.low_bits low <> 0uL &&
    U64.logand names.middle_bits middle <> 0uL && U64.logand names.high_bits high <> 0uL in
  read_ret input #frame ({
    low_bits = U64.logor names.low_bits low;
    middle_bits = U64.logor names.middle_bits middle;
    high_bits = U64.logor names.high_bits high
  }, collision)

let variance_prefix (input:tape) (#frame:slprop) (st:parser_state) (allow_variance:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first_byte = (fun () -> peek input #frame st.offset) in
  if first_byte <> 111uy && (first_byte <> 105uy || not allow_variance) then read_ret input #frame st
  else
    let! in_ = (fun () -> if first_byte = 105uy then keyword input #frame st.offset 2ul 0x696euL else read_ret input #frame false) in
    let! first = (fun () -> if in_ then
      let! gap = (fun () -> trivia input #frame (plus st.offset 2ul)) in
      read_ret input #frame (if gap.newline then failed st 1ul else from_cursor st gap)
      else read_ret input #frame st) in
    let! out_ = (fun () -> keyword input #frame first.offset 3ul 0x6f7574uL) in
    if first.status <> 0ul || not out_ then read_ret input #frame first
    else
      let! gap = (fun () -> trivia input #frame (plus first.offset 3ul)) in
      let candidate = from_cursor first gap in
      let! extends = (fun () -> keyword input #frame candidate.offset 7ul 0x657874656e6473uL) in
      let! named = (fun () -> if allow_variance && not extends then name input #frame candidate.offset false true
        else read_ret input #frame { at = first.offset; ok = false; newline = false }) in
      let! repeated = (fun () -> if named.ok then keyword input #frame candidate.offset 3ul 0x6f7574uL else read_ret input #frame false) in
      if extends || repeated then read_ret input #frame (failed first 1ul)
      else read_ret input #frame (if candidate.status = 0ul && not gap.newline && named.ok then candidate else first)

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
    if after.newline && not allow_newline then read_ret input #frame state
    else if fuel = 0ul then read_ret input #frame (failed tail 1ul)
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
    let! annotated = (fun () -> delimited_type input #frame st fuel) in
    let! st = (fun () -> skip input #frame annotated) in
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
      // The operand may also be an object type or a type in parentheses, as in [{ a: 1 }?] and [('a' | 'b')?].
      let! opened = (fun () -> skip input #frame start) in
      let! opener = (fun () -> peek input #frame opened.offset) in
      let! operand = (fun () -> if opener = 123uy || opener = 40uy then type_term input #frame opened fuel false false
        else type_reference input #frame start fuel) in
      let! primary = (fun () -> type_suffixes input #frame operand 0ul 16ul false) in
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
  let! first = (fun () -> peek input #frame st.offset) in
  let! getter = (fun () -> if first = 103uy then keyword input #frame st.offset 3ul 0x676574uL else read_ret input #frame false) in
  let! setter = (fun () -> if first = 115uy then keyword input #frame st.offset 3ul 0x736574uL else read_ret input #frame false) in
  let! key = (fun () -> if getter || setter then
    let! gap = (fun () -> trivia input #frame (plus st.offset 3ul)) in
    let! first = (fun () -> peek input #frame gap.at) in
    if gap.ok && not gap.newline && G.identifier_start first then
      let! end_ = (fun () -> scan_class input #frame gap.at G.Identifier) in
      read_ret input #frame { st with offset = end_ }
    else read_ret input #frame st
    else read_ret input #frame st) in
  if key.offset <> st.offset && setter then
    // set name(value: T): one named parameter with an optional annotation, and no result type.
    let! opening = (fun () -> skip input #frame key) in
    let! parameters = (fun () -> consume input #frame opening 40uy) in
    let! parameter = (fun () -> skip input #frame parameters) in
    let! named = (fun () -> name input #frame parameter.offset false false) in
    let! tail = (fun () -> skip input #frame (from_cursor parameter named)) in
    let! colon = (fun () -> same input #frame tail.offset 58uy) in
    let! typed = (fun () -> if colon then
        (let! annotation = (fun () -> consume input #frame tail 58uy) in annotation_type input #frame annotation fuel 64ul)
      else read_ret input #frame tail) in
    let! closing = (fun () -> skip input #frame typed) in
    consume input #frame closing 41uy
  else if key.offset <> st.offset then
    let! opening = (fun () -> skip input #frame key) in
    let! parameters = (fun () -> consume input #frame opening 40uy) in
    let! closing = (fun () -> skip input #frame parameters) in
    let! after = (fun () -> consume input #frame closing 41uy) in
    let! colon = (fun () -> skip input #frame after) in
    let! typed = (fun () -> consume input #frame colon 58uy) in
    annotation_type input #frame typed fuel 64ul
  else
    let! is_readonly = (fun () -> keyword input #frame st.offset 8ul 0x726561646f6e6c79uL) in
    let! key_start =
      (fun () -> if is_readonly then
        let! after = (fun () -> skip input #frame { st with offset = plus st.offset 8ul }) in
        let! next_key = (fun () -> peek input #frame after.offset) in
        read_ret input #frame (if G.identifier_start next_key || G.decimal_digit next_key ||
          next_key = 34uy || next_key = 39uy || next_key = 91uy then after else st)
      else read_ret input #frame (st)) in
    let! first = (fun () -> peek input #frame key_start.offset) in
    let! head =
      (fun () -> if first = 91uy then read_bracket_type_key input #frame key_start
      else
        let unnamed = first = 40uy || first = 60uy in
        let! key_end = (fun () -> if unnamed then read_ret input #frame key_start
          else
            let! key = (fun () -> if G.decimal_digit first then decimal_property_name input #frame key_start.offset first
              else property_name input #frame key_start) in
            skip input #frame (from_cursor key_start key)) in
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
          let! opening = (fun () -> if byte = 60uy then (let! anf_value_8 = (fun () -> ((let! anf_value_9 = (fun () -> (consume input #frame after 60uy)) in type_parameters input #frame anf_value_9 inner 64ul false))) in skip input #frame anf_value_8)
            else read_ret input #frame (after)) in
          let! parameters = (fun () -> (let! anf_value_10 = (fun () -> (consume input #frame opening 40uy)) in signature_parameters input #frame anf_value_10 inner 64ul anf_value_10.offset empty_signature_names)) in
          // A method signature may stand without a result type, as in { run() }.
          let! after_parameters = (fun () -> skip input #frame parameters) in
          let! typed = (fun () -> same input #frame after_parameters.offset 58uy) in
          if typed then (let! anf_value_11 = (fun () -> consume input #frame after_parameters 58uy) in result_type input #frame anf_value_11 fuel)
          else read_ret input #frame parameters
      // A property may stand without a type, as in interface I { x; y? }.
      else if byte = 58uy then (let! anf_value_13 = (fun () -> (consume input #frame after 58uy)) in delimited_type input #frame anf_value_13 fuel)
      // It is taken when a separator or the closing brace follows; a line break alone is left to TypeScript.
      else read_ret input #frame (if byte = 59uy || byte = 44uy || byte = 125uy then after else failed after 1ul)
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
and signature_parameters (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining origin:U32.t) (names:signature_names)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 41uy) in if anf_value_1 then consume input #frame st 41uy
  else if remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! spread = (fun () -> spread_at input #frame st.offset) in
    let! st = (fun () -> if spread then skip input #frame { st with offset = plus st.offset 3ul } else read_ret input #frame (st)) in
    let! brace = (fun () -> if not spread then same input #frame st.offset 123uy else read_ret input #frame false) in
    if brace then
      let! key = (fun () -> skip input #frame { st with offset = next st.offset }) in
      let! closed = (fun () -> signature_shorthand_names input #frame key origin 16ul) in
      let! tail = (fun () -> skip input #frame closed) in
      let! colon = (fun () -> consume input #frame tail 58uy) in
      let! annotation = (fun () -> annotation_type input #frame colon fuel 64ul) in
      let! tail = (fun () -> skip input #frame annotation) in
      let! comma = (fun () -> same input #frame tail.offset 44uy) in
      let! tail = (fun () -> if comma then skip input #frame { tail with offset = next tail.offset } else read_ret input #frame tail) in
      consume input #frame tail 41uy
    else
      let! receiver = (fun () -> if remaining = 64ul then keyword input #frame st.offset 4ul 0x74686973uL else read_ret input #frame (false)) in
      let! named = (fun () -> if receiver && not spread then read_ret input #frame ({ st with offset = plus st.offset 4ul })
        else (let! anf_value_2 = (fun () -> (name input #frame st.offset false false)) in read_ret input #frame (from_cursor st anf_value_2))) in
      let! names, repeated = (fun () -> if named.status = 0ul then mark_signature_name input #frame names st.offset named.offset
        else read_ret input #frame (names, false)) in
      let named = if repeated then failed named 1ul else named in
      let! tail = (fun () -> skip input #frame named) in
      let! optional = (fun () -> same input #frame tail.offset 63uy) in
      let! tail = (fun () -> if optional && not receiver && not spread then (let! anf_value_3 = (fun () -> (consume input #frame tail 63uy)) in skip input #frame anf_value_3) else read_ret input #frame (tail)) in
      // A parameter of a signature may stand without a type, as in (string) => string[].
      let! colon = (fun () -> same input #frame tail.offset 58uy) in
      let! annotated = (fun () -> if colon || receiver then
          (let! anf_value_4 = (fun () -> (consume input #frame tail 58uy)) in annotation_type input #frame anf_value_4 fuel 64ul)
        else read_ret input #frame tail) in
      let! end_ = (fun () -> skip input #frame annotated) in
      let! comma = (fun () -> same input #frame end_.offset 44uy) in
      if comma && not spread then
        (let! anf_value_5 = (fun () -> (consume input #frame end_ 44uy)) in signature_parameters input #frame anf_value_5 fuel (minus remaining 1ul) origin names)
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
            let! params = (fun () -> if allow_signature then signature_parameters input #frame inside inner 64ul inside.offset empty_signature_names
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
  let! start = (fun () -> if generic then (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (consume input #frame state 60uy)) in type_parameters input #frame anf_value_2 fuel 64ul false))) in skip input #frame anf_value_1)
    else read_ret input #frame (state)) in
  let! params = (fun () -> (let! anf_value_3 = (fun () -> (consume input #frame start 40uy)) in signature_parameters input #frame anf_value_3 fuel 64ul anf_value_3.offset empty_signature_names)) in
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
          let! value = (fun () -> delimited_type input #frame { state with offset = plus at 2ul } fuel) in
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
and delimited_type (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 4; 1]) =
  let! annotated = (fun () -> annotation_type input #frame state fuel 64ul) in
  if annotated.status = 0ul then read_ret input #frame annotated
  else
    let! start = (fun () -> skip input #frame state) in
    let! infer_ = (fun () -> keyword input #frame start.offset 5ul 0x696e666572uL) in
    if infer_ then type_terms input #frame start fuel 64ul false true else read_ret input #frame annotated
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

and type_parameters (input:tape) (#frame:slprop) (state:parser_state) (fuel remaining:U32.t) (allow_variance:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul || remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! st = (fun () -> (let! anf_value_1 = (fun () -> keyword input #frame st.offset 5ul 0x636f6e7374uL) in if anf_value_1 then
      skip input #frame { st with offset = plus st.offset 5ul }
      else read_ret input #frame (st))) in
    let! st = (fun () -> variance_prefix input #frame st allow_variance) in
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
        else type_parameters input #frame after fuel (minus remaining 1ul) allow_variance)
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

let capture_parsed_annotation (input:tape) (state typed:parser_state) (kind:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if not input.capture_types || typed.status <> 0ul || typed.offset = state.offset then ret input typed
  else
    let! first = (fun () -> skip input state) in
    let! colon = (fun () -> same input first.offset 58uy) in
    if colon then record_jsx_span input typed kind first.offset typed.offset
    else ret input typed

let capture_annotation (input:tape) (state:parser_state) (result:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! typed = (fun () -> if result then result_annotation input state else simple_annotation input state) in
  capture_parsed_annotation input state typed 7ul

let expression_type_arguments (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> (consume input #frame state 60uy)) in type_list input #frame anf_value_1 16ul 64ul 62uy false)

let call_type_arguments (input:tape) (state:parser_state) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! arguments = (fun () -> expression_type_arguments input state) in
  let! after = (fun () -> skip input arguments) in
  let! call = (fun () -> same input after.offset 40uy) in
  if call then record_jsx_span input after 10ul state.offset arguments.offset
  else ret input (failed after 1ul)

let optional_type_parameters (input:tape) (#frame:slprop) (state:parser_state) (allow_variance:bool) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if state.status <> 0ul then read_ret input #frame (state)
  else (let! anf_value_1 = (fun () -> same input #frame state.offset 60uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> (consume input #frame state 60uy)) in type_parameters input #frame anf_value_2 16ul 64ul allow_variance)
  else read_ret input #frame (state))

let capture_type_parameters (input:tape) (state:parser_state) (allow_variance:bool) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! first = (fun () -> skip input state) in
  let! arguments = (fun () -> optional_type_parameters input first allow_variance) in
  if not input.capture_types || arguments.offset = first.offset then skip input arguments
  else
    let! recorded = (fun () -> record_jsx_span input arguments 10ul first.offset arguments.offset) in
    skip input recorded

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
  let! end_ = (fun () -> (let! anf_value_1 = (fun () -> ((let! anf_value_2 = (fun () -> (capture_annotation input rest.state false)) in skip input anf_value_2))) in consume input anf_value_1 41uy)) in
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

let missed_arrow (state:parser_state) : parameter_list =
  { names = { state = failed state 1ul; used = state.local_names }; non_simple = false }

let bare_arrow_parameters (input:tape) (state:parser_state)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) =
  let used = state.local_names in
  let missed = missed_arrow state in
  let! end_ = (fun () -> scan_class input state.offset G.Identifier) in
  let! at = (fun () -> scan_class input end_ G.HorizontalSpace) in
  let! byte = (fun () -> peek input at) in
  let! body = (fun () ->
    if byte = 47uy then arrow_token input { state with offset = end_ }
    else if byte = 61uy then
      let! greater = (fun () -> same input (next at) 62uy) in
      ret input (if greater then { state with offset = plus at 2ul } else failed state 1ul)
    else ret input (failed state 1ul)) in
  if body.status <> 0ul then ret input missed
  else
    let! param = (fun () -> bind_since input state binding_region_width used used state.offset) in
    ret input (if param.state.status <> 0ul then missed
      else { missed with names = { param with state = { param.state with offset = body.offset } } })

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
  if eligible then type_parameters input #frame head 16ul 64ul false else read_ret input #frame (failed head 1ul)

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
  if state.status <> 0ul || (not non_simple && strict_locals state) then read_ret input #frame (state)
  else
    let! first = (fun () -> (let! anf_value_1 = (fun () -> (consume input #frame state 123uy)) in skip input #frame anf_value_1)) in
    let! byte = (fun () -> peek input #frame first.offset) in
    if first.status <> 0ul || (byte <> 34uy && byte <> 39uy) then read_ret input #frame state
    // Non-simple parameters have an early error for a strict directive in the prologue.
    else if non_simple then read_ret input #frame (failed state 1ul)
    else
      let! strict = (fun () -> strict_directive input #frame first.offset) in
      read_ret input #frame ({ state with strict_script = strict })

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

let ambiguous_assertion_update (input:tape) (#frame:slprop) (question:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
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
    // Without a semicolon the statement ends at its last token. The trivia behind it belongs to what follows:
    // an erased declaration must not take a /*#__PURE__*/ comment on the next line with it.
    else read_ret input #frame (if tail.newline || st.offset = input.size || (before_brace && byte = 125uy) then
      { state with offset = end_at }
    else failed st 1ul)

let same_label_name (input:tape) (#frame:slprop) (start first last:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! original_name = (fun () -> name input #frame start false false) in
  let length = minus last first in
  if original_name.ok && length = minus original_name.at start then same_bytes input #frame start first length
  else read_ret input #frame false

let jump_statement (input:tape) (#frame:slprop) (state:parser_state) (jumps:jump_context) (width:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let end_at = plus state.offset width in
  match jumps with
  | NoJump -> read_ret input #frame (failed state 1ul)
  | BreakOnly -> if width = 5ul then statement_end input #frame state end_at true else read_ret input #frame (failed state 1ul)
  | LoopJump -> statement_end input #frame state end_at true
  | NamedLoop _ | NestedNamedLoops _ _ ->
    let! after = (fun () -> trivia input #frame end_at) in
    let! target = (fun () -> if after.ok && not after.newline then name input #frame after.at false false
      else read_ret input #frame { at = after.at; ok = false; newline = after.newline }) in
    if not target.ok then statement_end input #frame state end_at true
    else
      let! equal = (fun () -> match jumps with
        | NamedLoop start -> same_label_name input #frame start after.at target.at
        | NestedNamedLoops outer inner ->
          let! matches = (fun () -> same_label_name input #frame inner after.at target.at) in
          if matches then read_ret input #frame true else same_label_name input #frame outer after.at target.at
        | _ -> read_ret input #frame false) in
      if equal then statement_end input #frame state target.at true
      else read_ret input #frame (failed state 1ul)

let labeled_loop_start (input:tape) (#frame:slprop) (state:parser_state)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! named = (fun () -> name input #frame state.offset false false) in
  let! colon = (fun () -> skip input #frame (from_cursor state named)) in
  let! start = (fun () -> (let! consumed = (fun () -> consume input #frame colon 58uy) in skip input #frame consumed)) in
  if start.status <> 0ul then read_ret input #frame start
  else
    let! kind = (fun () -> statement_kind input #frame start.offset) in
    read_ret input #frame (if kind = 2ul || kind = 3ul || kind = 4ul then start else failed start 1ul)

let local_width (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame start) in
  if first = 99uy then ((let! anf_value_1 = (fun () -> keyword input #frame start 5ul 0x636f6e7374uL) in if anf_value_1 then read_ret input #frame (5ul) else read_ret input #frame (0ul)))
  else if first = 108uy then ((let! anf_value_2 = (fun () -> keyword input #frame start 3ul 0x6c6574uL) in if anf_value_2 then read_ret input #frame (3ul) else read_ret input #frame (0ul)))
  else read_ret input #frame (0ul)

let resource_declaration_start (input:tape) (#frame:slprop) (state:parser_state) (first:U8.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> if first = 117uy then read_ret input #frame state
    else if first = 97uy && state.await_allowed then
      let! await_ = (fun () -> keyword input #frame state.offset 5ul 0x6177616974uL) in
      if not await_ then read_ret input #frame (failed state 1ul)
      else
        let! gap = (fun () -> trivia input #frame (plus state.offset 5ul)) in
        read_ret input #frame (if gap.newline then failed state 1ul else from_cursor state gap)
    else read_ret input #frame (failed state 1ul)) in
  let! using_ = (fun () -> if start.status = 0ul then keyword input #frame start.offset 5ul 0x7573696e67uL
    else read_ret input #frame false) in
  if not using_ then read_ret input #frame (failed start 1ul)
  else
    let! gap = (fun () -> trivia input #frame (plus start.offset 5ul)) in
    let! byte = (fun () -> peek input #frame gap.at) in
    read_ret input #frame (if gap.newline || not (G.identifier_start byte) then failed start 1ul else from_cursor start gap)

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
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (optional_type_parameters input #frame state true)) in skip input #frame anf_value_1)) in
  let! alias = (fun () -> (let! anf_value_2 = (fun () -> (consume input #frame st 61uy)) in annotation_type input #frame anf_value_2 16ul 256ul)) in
  statement_end input #frame alias alias.offset before_brace

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

let interface_tail (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (optional_type_parameters input #frame state true)) in skip input #frame anf_value_1)) in
  let! extends = (fun () -> keyword input #frame st.offset 7ul 0x657874656e6473uL) in
  let! st = (fun () -> if extends then interface_bases input #frame { st with offset = plus st.offset 7ul } 64ul else read_ret input #frame (st)) in
  (let! anf_value_2 = (fun () -> (consume input #frame st 123uy)) in object_type input #frame anf_value_2 15ul input.size)

// The body of an enum inside a function is read as tokens up to its closing brace. The emitter evaluates
// every member itself and declines the file unless each is a name with a constant or a string, so no
// text from the body reaches the output unchecked.
let rec enum_body_tokens (input:tape) (#frame:slprop) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame st
  else if fuel = 0ul then read_ret input #frame (failed st 3ul)
  else
    let! byte = (fun () -> peek input #frame st.offset) in
    if byte = 125uy then consume input #frame st 125uy
    else if byte = 34uy || byte = 39uy then
      let! literal = (fun () -> string_end input #frame (next st.offset) byte input.size false) in
      enum_body_tokens input #frame (from_cursor st literal) (minus fuel 1ul)
    else if G.identifier_continue byte || byte = 61uy || byte = 44uy || byte = 43uy || byte = 45uy || byte = 42uy || byte = 47uy ||
        byte = 37uy || byte = 124uy || byte = 38uy || byte = 94uy || byte = 126uy || byte = 40uy || byte = 41uy || byte = 60uy ||
        byte = 62uy || byte = 46uy then
      enum_body_tokens input #frame { st with offset = next st.offset } (minus fuel 1ul)
    else read_ret input #frame (failed st 1ul)

// `enum` or `const enum` at the start of a statement, with the offset of the enum keyword.
let local_enum_start (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame start) in
  let! constant = (fun () -> if first = 99uy then keyword input #frame start 5ul 0x636f6e7374uL else read_ret input #frame false) in
  let! gap = (fun () -> if constant then trivia input #frame (plus start 5ul) else read_ret input #frame { at = start; ok = true; newline = false }) in
  let! enumeration = (fun () -> if gap.ok && (constant || first = 101uy) then keyword input #frame gap.at 4ul 0x656e756duL else read_ret input #frame false) in
  let! name_gap = (fun () -> if enumeration then trivia input #frame (plus gap.at 4ul) else read_ret input #frame { at = start; ok = false; newline = false }) in
  let! name_start = (fun () -> peek input #frame name_gap.at) in
  // `enum` is an ordinary name in a script, so a declaration needs its name on the same line.
  read_ret input #frame { at = gap.at; ok = enumeration && name_gap.ok && not name_gap.newline && not gap.newline && G.identifier_start name_start; newline = false }

// A block-scoped enum, kept out of line for the same reason. Kind 32 tells the emitter to declare it with let.
let local_enum_declaration (input:tape) (st:parser_state) (keyword_at:U32.t) (floor used:names_used)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let declared = record_binding_mode st LexicalLocals in
  let! named = (fun () -> skip input { declared with offset = plus keyword_at 4ul }) in
  let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
  let! tracked = (fun () -> record_local_pattern input decl.state used decl.used) in
  let! opening = (fun () -> (let! body = (fun () -> skip input tracked) in consume input body 123uy)) in
  let! closed = (fun () -> enum_body_tokens input opening input.size) in
  let! recorded = (fun () -> record_jsx_span input closed 32ul st.offset closed.offset) in
  ret input ({ decl with state = { recorded with local_names = decl.used } })

let local_type_declaration (input:tape) (state:parser_state) (width:U32.t) (floor used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! start = (fun () -> skip input { state with offset = plus state.offset width }) in
  // A local type shares its name with a value, as a module-level type does.
  let! decl = (fun () -> bind_in_namespace input start binding_region_width floor used start.offset
    (if width = 9ul then InterfaceName else TypeName)) in
  let! valid = (fun () -> admissible_type_binding input start.offset decl.state.offset) in
  let! st = (fun () -> if valid then (if width = 9ul then interface_tail input decl.state else type_alias_tail input decl.state true) else ret input (failed decl.state 1ul)) in
  ret input ({ decl with state = { st with local_names = decl.used } })

let tag_space (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! at = (fun () -> scan_class input #frame state.offset G.Space) in
  read_ret input #frame ({ state with offset = at })

let jsx_attribute_name (input:tape) (#frame:slprop) (at:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> name input #frame at true false) in
  let! qualified = (fun () -> if first.ok then same input #frame first.at 58uy else read_ret input #frame false) in
  if qualified then name input #frame (next first.at) true false
  else read_ret input #frame first

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
  if after.offset = input.size || byte = 59uy || byte = 41uy || byte = 93uy || byte = 125uy || byte = 44uy then
    read_ret input #frame true
  else if byte = 60uy || (byte = 62uy && type_end.offset <> after.offset) then
    let! second = (fun () -> peek input #frame (next after.offset)) in
    read_ret input #frame (second = byte || second = 61uy)
  else read_ret input #frame (false)

type generic_postfix = { type_cursor:parser_state; calls:bool; instantiates:bool }

let read_generic_postfix (input:tape) (#frame:slprop) (st:parser_state) (allow_instantiation:bool)
  : Tot (stt generic_postfix (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! generic = (fun () -> expression_type_arguments input #frame st) in
  let! after = (fun () -> skip input #frame generic) in
  // Type arguments belong to a call or to a tagged template that follows them.
  let! follower = (fun () -> peek input #frame after.offset) in
  let call = after.status = 0ul && U32.lt after.offset input.size && (follower = 40uy || follower = 96uy) in
  let! instantiates =
    (fun () -> if after.status = 0ul && not call && allow_instantiation then instantiation_follower input #frame generic after
    else read_ret input #frame (false)) in
  read_ret input #frame ({ type_cursor = generic; calls = call; instantiates })

let postfix_start (input:tape) (#frame:slprop) (base:parsed) : Tot (stt postfix_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! after = (fun () -> trivia input #frame base.parser.offset) in
  let st = from_cursor base.parser after in
  let! byte = (fun () -> peek input #frame st.offset) in
  let! increment = (fun () -> if after.newline then read_ret input #frame (0ul) else update_width input #frame st.offset byte) in
  // The result of a call takes type arguments for a further call, as in f()<T>().
  let! closing = (fun () -> if byte = 60uy && U32.gt base.range.G.last base.range.G.first then peek input #frame (minus base.range.G.last 1ul)
    else read_ret input #frame 0uy) in
  let! generic =
    (fun () -> if byte = 60uy && st.offset = base.range.G.last &&
        (can_assign base.target || base.target = OptionalChain || closing = 41uy) then
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

let abstract_modifier (input:tape) (#frame:slprop) (offset:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! present = (fun () -> keyword input #frame offset 8ul 0x6162737472616374uL) in
  if not present then read_ret input #frame { at = offset; ok = false; newline = false }
  else
    let! after = (fun () -> trivia input #frame (plus offset 8ul)) in
    read_ret input #frame { after with ok = after.ok && not after.newline }

let abstract_class_start (input:tape) (#frame:slprop) (offset:U32.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame offset) in
  if first <> 97uy then read_ret input #frame { at = offset; ok = false; newline = false }
  else
    let! modifier = (fun () -> abstract_modifier input #frame offset) in
    let! class_ = (fun () -> if modifier.ok then class_keyword input #frame modifier.at else read_ret input #frame false) in
    read_ret input #frame { modifier with ok = class_ }

let abstract_member_modifier (input:tape) (#frame:slprop) (start:U32.t) (byte:U8.t)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if byte = 97uy then abstract_modifier input #frame start
  else
    let! public_ = (fun () -> keyword input #frame start 6ul 0x7075626c6963uL) in
    let! protected_ = (fun () -> if public_ then read_ret input #frame false else
      let! prefix = (fun () -> word input #frame start 8ul 0uL) in
      if prefix = 0x70726f7465637465uL then keyword input #frame (plus start 8ul) 1ul 0x64uL
      else read_ret input #frame false) in
    if not public_ && not protected_ then read_ret input #frame { at = start; ok = false; newline = false }
    else
      let! after = (fun () -> trivia input #frame (plus start (if public_ then 6ul else 9ul))) in
      if after.ok && not after.newline then abstract_modifier input #frame after.at
      else read_ret input #frame { after with ok = false }

type class_key = {
  after_key:parser_state; first:U32.t; last:U32.t; static_:bool; async_:bool; readonly_:bool; arity:parameter_arity;
  generator_:bool; private_:bool; quoted_:bool; computed:bool; modifier_flags:U32.t; modifiers_end:U32.t
}

type class_kind = | OrdinaryClass | AbstractClass | AmbientClass

type pending_overload = { key_span:G.span; key_flags:U32.t; key_async:bool }

let no_overload : pending_overload = { key_span = { G.first = 0ul; G.last = 0ul }; key_flags = 0ul; key_async = false }

let class_key_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame state.offset) in
  read_ret input #frame (G.identifier_start byte || G.decimal_digit byte ||
    byte = 34uy || byte = 39uy || byte = 42uy || byte = 35uy || byte = 91uy)

type class_prefix = { key_state:parser_state; flags:U32.t }

let class_access_flags : U32.t = 100ul

let class_modifier_width (input:tape) (#frame:slprop) (at:U32.t) (first:U8.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  if first = 115uy then ((let! anf_value_1 = (fun () -> keyword input #frame at 6ul 0x737461746963uL) in if anf_value_1 then read_ret input #frame (6ul) else read_ret input #frame (0ul)))
  else if first = 114uy then ((let! anf_value_2 = (fun () -> keyword input #frame at 8ul 0x726561646f6e6c79uL) in if anf_value_2 then read_ret input #frame (8ul) else read_ret input #frame (0ul)))
  else if first = 111uy then ((let! anf_value_3 = (fun () -> keyword input #frame at 8ul 0x6f76657272696465uL) in if anf_value_3 then read_ret input #frame (8ul) else read_ret input #frame (0ul)))
  else if first = 100uy then
    let! declaration = (fun () -> keyword input #frame at 7ul 0x6465636c617265uL) in
    read_ret input #frame (if declaration then 7ul else 0ul)
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
        let bit = if first = 115uy then 1ul else if first = 114uy then 2ul else if first = 111uy then 8ul else if first = 100uy then 16ul
          else if width = 6ul then 4ul else if width = 7ul then 32ul else 64ul in
        let overlap = if first = 112uy then class_access_flags else bit in
        if fuel = 0ul || U32.logand overlap flags <> 0ul then read_ret input #frame ({ ordinary with key_state = failed st 1ul })
        else class_modifiers input #frame after (U32.logor bit flags) (minus fuel 1ul)

let computed_property_name (input:tape) (#frame:slprop) (state:parser_state)
  : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> skip input #frame { state with offset = next state.offset }) in
  let! forbidden = (fun () -> forbidden_field_arguments input #frame start) in
  if forbidden then read_ret input #frame { at = start.offset; ok = false; newline = false }
  else
    let! delimiter = (fun () -> peek input #frame start.offset) in
    let! key = (fun () -> if delimiter = 34uy || delimiter = 39uy then
      let! last = (fun () -> scan_class input #frame (next start.offset) G.Identifier) in
      consume input #frame { start with offset = last } delimiter
    else
      let! first = (fun () -> name input #frame start.offset false false) in
      qualified_name input #frame (from_cursor start first) 16ul) in
    let! after = (fun () -> skip input #frame key) in
    let! end_ = (fun () -> consume input #frame after 93uy) in
    read_ret input #frame { at = end_.offset; ok = end_.status = 0ul; newline = false }

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
  let computed = byte = 91uy in
  let! key = (fun () -> if private_ then private_identifier input #frame key_start.offset
    else if computed then computed_property_name input #frame key_start
    else if G.decimal_digit byte then decimal_property_name input #frame key_start.offset byte
    else property_name input #frame key_start) in
  read_ret input #frame (let key_end = if private_ && U32.logand prefix.flags (U32.logor class_access_flags 8ul) <> 0ul then failed key_start 1ul
    else from_cursor key_start key in
  let first = if quoted then next key_start.offset else key_start.offset in
  let last = if quoted then minus key.at 1ul else key.at in
  { after_key = key_end; first; last; async_; arity = accessor.arity; generator_ = generator.generator; private_;
    quoted_ = quoted; computed; modifier_flags = prefix.flags; modifiers_end = start.offset;
    static_ = U32.logand prefix.flags 1ul <> 0ul; readonly_ = U32.logand prefix.flags 2ul <> 0ul })

let constructor_property (input:tape) (#frame:slprop) (state:parser_state)
  : Tot (stt (parser_state & U32.t) (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! first = (fun () -> peek input #frame state.offset) in
  if first <> 112uy && first <> 114uy && first <> 111uy then read_ret input #frame (state, state.offset)
  else
    // An accessibility modifier, override and readonly may each appear once. static and declare cannot.
    let! prefixes = (fun () -> class_modifiers input #frame state 0ul 3ul) in
    let property = prefixes.key_state in
    if property.status <> 0ul || prefixes.flags = 0ul || prefixes.flags = 8ul || U32.logand prefixes.flags 17ul <> 0ul then read_ret input #frame (state, state.offset)
    else
      let! binding = (fun () -> name input #frame property.offset false true) in
      let! tail = (fun () -> trivia input #frame binding.at) in
      let! optional = (fun () -> same input #frame tail.at 63uy) in
      let! colon = (fun () -> if optional then trivia input #frame (next tail.at) else read_ret input #frame (tail)) in
      let! typed = (fun () -> same input #frame colon.at 58uy) in
      let! follower = (fun () -> peek input #frame tail.at) in
      let initialized = not optional && not typed && (follower = 61uy || follower = 44uy || follower = 41uy) in
      read_ret input #frame (if binding.ok && tail.ok && colon.ok && (typed || initialized) then (property, binding.at)
        else (state, state.offset))

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

let read_atom_head (input:tape) (#frame:slprop) (st:parser_state) : Tot (stt atom_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let start_pos = st.offset in
  let! ch = (fun () -> peek input #frame start_pos) in
  let! imported = (fun () -> if ch = 105uy then keyword input #frame start_pos 6ul 0x696d706f7274uL else read_ret input #frame (false)) in
  let! super_ = (fun () -> if ch = 115uy && st.super_context <> NoSuper && st.super_context <> FunctionBody then
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

let left_shift_type_ambiguity (input:tape) (#frame:slprop) (start tail:parser_state)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! byte = (fun () -> peek input #frame tail.offset) in
  if byte = 62uy then
    let! first = (fun () -> skip input #frame start) in
    let! named = (fun () -> name input #frame first.offset false false) in
    let! after = (fun () -> skip input #frame (from_cursor first named)) in
    read_ret input #frame (after.status <> 0ul || after.offset <> tail.offset)
  else if byte <> 124uy && byte <> 38uy then read_ret input #frame false
  else
    let! annotation = (fun () -> annotation_type input #frame start 16ul 64ul) in
    let! greater = (fun () -> skip input #frame annotation) in
    if greater.status = 0ul then same input #frame greater.offset 62uy else read_ret input #frame false

let finish_jsx_expression (input:tape) (state:parser_state) (first:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! closed = (fun () -> consume input state 125uy) in
  record_jsx_span input closed 5ul first state.offset

let combine_binary (input:tape) (lhs rhs:parsed) (st:parser_state) (op:binary_operator) (first:U8.t) (reserve:bool)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) =
  if rhs.parser.status <> 0ul then ret input (rhs)
  // Multiple opening angles and a packed right shift can be nested type arguments.
  else if op.boundary = 1ul && lhs.open_angle && rhs.right_shift then ret input (empty_range (failed rhs.parser 1ul))
  else
    let logical = (U32.(op.strength <=^ 2ul) && not op.nullish) || lhs.shortcut = 1ul || rhs.shortcut = 1ul in
    let nullish = op.nullish || lhs.shortcut = 2ul || rhs.shortcut = 2ul in
    if logical && nullish then ret input (empty_range (failed rhs.parser 1ul))
    else
      let! result = (fun () -> if not reserve || input.count_only then ret input (rhs.parser)
        else emit_comparison_in_workspace input rhs.parser st.count op.boundary st.offset lhs.range rhs.range) in
      ret input (let shortcut = if logical then 1ul else if nullish then 2ul else 0ul in
      { parser = result; range = { lhs.range with G.last = rhs.range.G.last }; shortcut;
        open_angle = lhs.open_angle || rhs.open_angle || op.boundary = 1ul;
        right_shift = lhs.right_shift || rhs.right_shift || (op.strength = 8ul && first = 62uy);
        outer_or = op.strength = 1ul && not op.nullish; target = NotAssignable })

let signature_end (input:tape) (#frame:slprop) (state opening:parser_state) (params:parameter_list) (annotation st:parser_state) (constructor:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! typed = (fun () -> skip input #frame params.names.state) in
  let! annotated_return = (fun () -> same input #frame typed.offset 58uy) in
  // A signature may stand without a result type, as in function f(); the extractor keeps the stricter form.
  if (not annotated_return && not constructor && not input.capture_types) || (not input.capture_types && st.count <> state.count) then
    read_ret input #frame (failed st 1ul)
  else
    let! checked = (fun () -> if params.non_simple || constructor then signature_parameters input #frame opening 15ul 64ul opening.offset empty_signature_names else read_ret input #frame (params.names.state)) in
    if checked.status <> 0ul || checked.offset <> params.names.state.offset then read_ret input #frame (failed st 1ul)
    else statement_end input #frame annotation annotation.offset false

let rec flat_assignment_members (input:tape) (#frame:slprop) (state:parser_state) (remaining:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input #frame state) in
  let! closing = (fun () -> same input #frame st.offset 125uy) in
  if st.status <> 0ul || closing then consume input #frame st 125uy
  else if remaining = 0ul then read_ret input #frame (failed st 1ul)
  else
    let! key = (fun () -> property_name input #frame st) in
    let! tail = (fun () -> skip input #frame (from_cursor st key)) in
    let! renamed = (fun () -> same input #frame tail.offset 58uy) in
    let! target =
      (fun () -> if renamed then
        let! colon = (fun () -> consume input #frame tail 58uy) in
        skip input #frame colon
      else read_ret input #frame st) in
    let! this_ = (fun () -> if renamed then keyword input #frame target.offset 4ul 0x74686973uL else read_ret input #frame false) in
    let! named = (fun () -> if this_ then read_ret input #frame { target with offset = plus target.offset 4ul }
      else
        let! binding = (fun () -> name input #frame target.offset false true) in
        read_ret input #frame (from_cursor target binding)) in
    let! target = (fun () -> if renamed then qualified_name input #frame named 16ul else read_ret input #frame named) in
    let target = if this_ && target.offset = named.offset then failed target 1ul else target in
    let! after = (fun () -> skip input #frame target) in
    let! comma = (fun () -> same input #frame after.offset 44uy) in
    if comma then
      let! next_member = (fun () -> consume input #frame after 44uy) in
      flat_assignment_members input #frame next_member (minus remaining 1ul)
    else consume input #frame after 125uy

let flat_assignment_head (input:tape) (#frame:slprop) (state:parser_state)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  let! brace = (fun () -> consume input #frame st 123uy) in
  if brace.status <> 0ul then read_ret input #frame brace
  else
    let! pattern = (fun () -> flat_assignment_members input #frame brace 64ul) in
    let! tail = (fun () -> skip input #frame pattern) in
    let! equal = (fun () -> consume input #frame tail 61uy) in
    let! follower = (fun () -> peek input #frame equal.offset) in
    read_ret input #frame (if follower = 61uy || follower = 62uy then failed equal 1ul else equal)

let rec type_arguments_end_at_call_close (input:tape) (#frame:slprop) (state:parser_state) (remaining:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! start = (fun () -> skip input #frame state) in
  let! byte = (fun () -> peek input #frame start.offset) in
  if start.status <> 0ul || remaining = 0ul then read_ret input #frame false
  else if byte = 41uy then read_ret input #frame true
  else
    let! value = (fun () -> delimited_type input #frame start 16ul) in
    let! tail = (fun () -> skip input #frame value) in
    let! byte = (fun () -> peek input #frame tail.offset) in
    if tail.status <> 0ul then read_ret input #frame false
    else if byte = 44uy then
      type_arguments_end_at_call_close input #frame { tail with offset = next tail.offset } (minus remaining 1ul)
    else read_ret input #frame (byte = 41uy)

// One more than the offset of the first `<` byte from an offset on, or of that offset if there is none. A
// closing angle can only matter behind the opening one, so the search for it starts there.
let rec first_less_from (input:tape) (#frame:slprop) (at stop:U32.t) (fallback:U32.t) (fuel:U32.t)
  : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ stop) then read_ret input #frame (next fallback)
  else
    let! byte = (fun () -> peek input #frame at) in
    if byte = 60uy then read_ret input #frame (next at)
    else first_less_from input #frame (next at) stop fallback (minus fuel 1ul)

// Whether a `>` byte that is not the head of an arrow stands between two offsets. Bytes in strings and
// comments count as well, which only declines more.
let rec bare_greater_between (input:tape) (#frame:slprop) (at stop:U32.t) (fuel:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ stop) then read_ret input #frame false
  else
    let! byte = (fun () -> peek input #frame at) in
    let! arrow = (fun () -> if byte = 62uy && U32.gt at 0ul then same input #frame (minus at 1ul) 61uy else read_ret input #frame false) in
    if byte = 62uy && not arrow then read_ret input #frame true
    else bare_greater_between input #frame (next at) stop (minus fuel 1ul)

// The offset behind the only `<` byte between two offsets, or zero when there is none or more than one.
let rec single_less_byte (input:tape) (#frame:slprop) (at stop found:U32.t) (fuel:U32.t)
  : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ stop) then read_ret input #frame found
  else
    let! byte = (fun () -> peek input #frame at) in
    if byte = 60uy && found <> 0ul then read_ret input #frame 0ul
    else single_less_byte input #frame (next at) stop (if byte = 60uy then next at else found) (minus fuel 1ul)

// An argument whose only `<` byte is a comparison with a name or a number that ends the argument, as in
// f(a.b && c < 3, 'text'). TypeScript tries a type argument list at that `<`, so the caller still has to show
// that the following arguments read as types up to the closing parenthesis, where the attempt fails. With one
// `<` byte in the argument, the operator the parser saw is that byte, whatever stands to its left.
let simple_less_argument (input:tape) (#frame:slprop) (start comma:parser_state)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! less = (fun () -> single_less_byte input #frame start.offset comma.offset 0ul (minus comma.offset start.offset)) in
  if less = 0ul then read_ret input #frame false
  else
    let! right = (fun () -> skip input #frame { start with offset = less }) in
    let! first = (fun () -> peek input #frame right.offset) in
    let! rhs = (fun () -> if G.decimal_digit first then number_end input #frame right.offset else name input #frame right.offset false false) in
    let! tail = (fun () -> skip input #frame (from_cursor right rhs)) in
    read_ret input #frame (tail.status = 0ul && tail.offset = comma.offset)

#push-options "--z3rlimit 30"
// The type of an angle-bracket assertion. It is a function of its own, and the build marks it as not to be
// inlined, so that the expression parser's common path stays small. The operand has to follow on the same line,
// because erasing the assertion must not leave a line break in front of it. Two opening angles in a row are a
// shift operator to the scanner, as in <<T>(x: T) => T>f. Kind 31 is erased only when it lies on one line.
let angle_assertion_head (input:tape) (st:parser_state) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let start_pos = st.offset in
  let! typed = (fun () -> annotation_type input { st with offset = next start_pos } 16ul 64ul) in
  let! closing = (fun () -> skip input typed) in
  let! closed = (fun () -> consume input closing 62uy) in
  let! gap = (fun () -> trivia input closed.offset) in
  let! doubled = (fun () -> same input (next start_pos) 60uy) in
  if doubled || closed.status <> 0ul || not gap.ok || gap.newline then ret input (failed st 1ul)
  else record_jsx_span input closed 31ul start_pos closed.offset

let class_index_signature (input:tape) (st:parser_state) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! head = (fun () -> read_bracket_type_key input st) in
  if not head.index_signature then ret input (failed st 1ul)
  else
    let! key_type = (fun () -> (let! colon = (fun () -> consume input head.key_end 58uy) in annotation_type input colon 16ul 64ul)) in
    let! last = (fun () -> (let! closing = (fun () -> skip input key_type) in consume input closing 93uy)) in
    let! value = (fun () -> (let! colon = (fun () -> skip input last) in consume input colon 58uy)) in
    let! typed = (fun () -> annotation_type input value 16ul 64ul) in
    statement_end input typed typed.offset true

// The end of a declaration with several declarators. A declarator whose value holds a less-than comparison may
// be followed by others only if no greater-than sign, an arrow head aside, follows up to the end of the
// statement: const a = x < y, b > (c) is one declarator with a generic call.
let declarators_end (input:tape) (ended:parser_state) (angled:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  if angled = 0ul || ended.status <> 0ul then ret input ended
  else
    let from = minus angled 1ul in
    let! closer = (fun () -> bare_greater_between input from ended.offset (minus ended.offset from)) in
    ret input (if closer then failed ended 1ul else ended)

let expression_end (input:tape) (closed:parser_state) (valid_array_target:bool) (angled:U32.t)
  : Tot (stt expression_items (heap input) (fun _ -> heap input)) =
  if angled = 0ul || closed.status <> 0ul then ret input ({ list_end = closed; valid_array_target })
  else
    let from = minus angled 1ul in
    let! closer = (fun () -> bare_greater_between input from closed.offset (minus closed.offset from)) in
    ret input (if closer then { list_end = failed closed 1ul; valid_array_target = false } else { list_end = closed; valid_array_target })

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
    // A type assertion in angle brackets applies to the unary expression after it, as a prefix operator does.
    // Both continue through the one recursive call below: a second call site made the build copy this
    // function's body once more and slowed every file.
    let asserted = prefix = 0ul && ch = 60uy && not st.jsx_allowed && input.capture_types in
    let! operand = (fun () -> if asserted then angle_assertion_head input st else ret input ({ st with offset = plus start_pos prefix })) in
    if prefix <> 0ul || asserted then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else if operand.status <> 0ul then ret input (empty_range operand)
      else
        let! child = (fun () -> atom input operand (minus fuel 1ul)) in
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
        let! element = (fun () -> jsx_element input st (minus fuel 1ul)) in
        // TypeScript ends the expression at a JSX element: a parenthesis, bracket, template or member access
        // behind it, even on the next line, starts something new or is an error. Lowered to a call it would
        // be applied to the element, so these are left to TypeScript.
        // Most elements are followed at once by a bracket, a comma or a semicolon, so trivia is skipped only
        // when the next byte can start it.
        let! direct = (fun () -> peek input element.offset) in
        let! behind = (fun () -> if direct = 32uy || direct = 10uy || direct = 13uy || direct = 9uy || direct = 47uy || U8.(direct >=^ 128uy) then
          skip input element else ret input element) in
        let! follower = (fun () -> peek input behind.offset) in
        let! dotted = (fun () -> if follower = 63uy then same input (next behind.offset) 46uy else ret input false) in
        // A non-null mark is an error behind a JSX element as well; != and !== are operators.
        let! marked = (fun () -> if follower = 33uy then (let! equality = (fun () -> same input (next behind.offset) 61uy) in ret input (not equality))
          else ret input false) in
        let closed = if element.status = 0ul && behind.status = 0ul &&
          (follower = 40uy || follower = 91uy || follower = 96uy || follower = 46uy || dotted || marked) then failed element 1ul else element in
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
            let! head = (fun () -> peek input target.offset) in
            if head = 46uy then
              let! meta = (fun () -> (let! dot = (fun () -> consume input target 46uy) in skip input dot)) in
              let! valid = (fun () -> if target.super_context <> NoSuper then keyword input meta.offset 6ul 0x746172676574uL
                else ret input false) in
              let result = if valid then { meta with offset = plus meta.offset 6ul } else failed meta 1ul in
              ret input (result, NotAssignable)
            else
              let! named =
                (fun () -> if head = 40uy then
                  let! inside = (fun () -> consume input { target with in_allowed = true } 40uy) in
                  let! grouped = (fun () -> comparison input inside inner) in
                  let! after = (fun () -> skip input grouped.parser) in
                  consume input { after with in_allowed = target.in_allowed } 41uy
                else
                  let! this_ = (fun () -> if head = 116uy then keyword input target.offset 4ul 0x74686973uL else ret input false) in
                  if this_ then ret input { target with offset = plus target.offset 4ul }
                  else (let! anf_value_5 = (fun () -> forbidden_field_arguments input target) in if anf_value_5 then ret input (failed target 1ul)
                  else (let! anf_value_6 = (fun () -> (name input target.offset false false)) in ret input (from_cursor target anf_value_6)))) in
              let! named = (fun () -> qualified_name input named 64ul) in
              let! gap = (fun () -> trivia input named.offset) in
              let! named, boundary = (fun () ->
                let! bracket = (fun () -> same input gap.at 91uy) in
                if not bracket then ret input (named, gap)
                else
                  let after = from_cursor named gap in
                  let! inside = (fun () -> consume input { after with in_allowed = true } 91uy) in
                  let! index = (fun () -> comparison input inside inner) in
                  let! closing = (fun () -> skip input index.parser) in
                  let! path = (fun () -> consume input { closing with in_allowed = target.in_allowed } 93uy) in
                  let! path = (fun () -> qualified_name input path 64ul) in
                  let! boundary = (fun () -> trivia input path.offset) in
                  ret input (path, boundary)) in
              let tail = from_cursor named boundary in
              // new Name!(...) asserts that the constructor is defined. The mark is erased like any other.
              let! bang = (fun () -> if input.capture_types && not boundary.newline then same input tail.offset 33uy else ret input false) in
              let! equality = (fun () -> if bang then same input (next tail.offset) 61uy else ret input false) in
              let! tail = (fun () -> if bang && not equality then
                  (let! recorded = (fun () -> record_jsx_span input { tail with offset = next tail.offset } 12ul tail.offset (next tail.offset)) in
                    skip input recorded)
                else ret input tail) in
              let! typed = (fun () -> same input tail.offset 60uy) in
              let! tail = (fun () -> if typed && tail.offset = named.offset then call_type_arguments input tail else ret input (tail)) in
              let! next_token = (fun () -> peek input tail.offset) in
              if next_token = 40uy then
                let! args = (fun () -> consume input tail 40uy) in
                let! list = (fun () -> expression_list input args inner input.size 41uy false) in
                ret input (list.list_end, NotAssignable)
              else if tail.status <> 0ul || head = 40uy || typed then ret input (failed tail 1ul, NotAssignable)
              else
                let! declaration = (fun () -> if not boundary.newline then ret input false
                  else if next_token = 108uy then keyword input tail.offset 3ul 0x6c6574uL
                  else if next_token = 99uy then keyword input tail.offset 5ul 0x636f6e7374uL
                  else if next_token = 118uy then keyword input tail.offset 3ul 0x766172uL
                  else if next_token = 102uy then
                    let! function_ = (fun () -> keyword input tail.offset 8ul 0x66756e6374696f6euL) in
                    if function_ then ret input true else keyword input tail.offset 3ul 0x666f72uL
                  else if G.identifier_start next_token then
                    let! name_end = (fun () -> scan_class input tail.offset G.Identifier) in
                    same input name_end 46uy
                  else ret input false) in
                let closed = tail.offset = input.size || next_token = 59uy || next_token = 44uy ||
                  next_token = 41uy || next_token = 93uy || next_token = 125uy in
                // Keep the constructor operand's end separate from the enclosing expression's trivia.
                ret input (if closed || declaration then (named, NotAssignable) else (failed tail 1ul, NotAssignable))
          else
            let inside = { st with offset = next start_pos } in
            if ch = 96uy then (let! anf_value_9 = (fun () -> template_body input inside start_pos inner input.size false) in ret input (anf_value_9, NotAssignable))
            else if ch = 91uy then
              if U32.(inner <=^ 8ul) then (let! anf_value_10 = (fun () -> deep_array_literal input inside inner) in ret input (anf_value_10, NotAssignable))
              else
                let! row = (fun () -> expression_list input inside inner input.size 93uy true) in
                ret input (row.list_end, (if row.valid_array_target then ArrayTarget else NotAssignable))
            else (let! anf_value_11 = (fun () -> object_members input inside inner input.size false false) in ret input (anf_value_11, NotAssignable))) in
        postfix input { parser = completed; range = { G.first = start_pos; G.last = completed.offset }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target }
          fuel input.size
    else if ch = 40uy then
      if fuel = 0ul then ret input (empty_range (failed st 3ul))
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let inside = { st with offset = next start_pos; depth; in_allowed = true } in
        let! flat = (fun () -> flat_assignment_head input inside) in
        // ({ a = 1, b: c = 2, ...rest } = value): a pattern with defaults is not an object literal.
        let! assignment = (fun () -> if flat.status = 0ul then ret input flat
          else
            let! opening = (fun () -> skip input inside) in
            let! brace = (fun () -> same input opening.offset 123uy) in
            if not brace then ret input flat
            else
              let! members = (fun () -> cover_assignment_members input { opening with offset = next opening.offset } (minus fuel 1ul) 64ul) in
              let! tail = (fun () -> skip input members) in
              let! equal = (fun () -> consume input tail 61uy) in
              let! follower = (fun () -> peek input equal.offset) in
              ret input (if follower = 61uy || follower = 62uy then failed equal 1ul else equal)) in
        let! inner = (fun () -> comparison input (if assignment.status = 0ul then assignment else inside) (minus fuel 1ul)) in
        let! consumed = (fun () -> skip input inner.parser) in
        let! comma = (fun () -> same input consumed.offset 44uy) in
        let! done_ =
          (fun () -> if consumed.status <> 0ul || not comma then consume input consumed 41uy
          else if inner.open_angle then ret input (failed consumed 1ul)
          else (let! anf_value_12 = (fun () -> (consume input consumed 44uy)) in grouped_tail input anf_value_12 (minus fuel 1ul) input.size)) in
        let done_ = { done_ with in_allowed = st.in_allowed } in
        let target = if assignment.status <> 0ul && not comma && can_assign_expression inner.target then inner.target else NotAssignable in
        postfix input { parser = done_; range = { G.first = start_pos; G.last = done_.offset }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target }
          fuel input.size
    else if G.decimal_digit ch || ch = 46uy then
      let! number = (fun () -> number_end input start_pos) in
      postfix input { parser = from_cursor st number; range = { G.first = start_pos; G.last = number.at }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }
        fuel input.size
    else
      let! named, target =
        (fun () -> if ch = 34uy || ch = 39uy then ((let! anf_value_13 = (fun () -> (let! anf_value_14 = (fun () -> (string_end input (next start_pos) ch input.size true)) in ret input (from_cursor st anf_value_14))) in ret input (anf_value_13, NotAssignable)))
        else if ch = 47uy then
          let! end_ = (fun () -> regex_end input (next start_pos)) in
          let body = from_cursor st end_ in
          let! recorded = (fun () -> record_jsx_span input body 17ul start_pos end_.at) in
          ret input (recorded, NotAssignable)
        else
          let! width =
            (fun () -> if ch = 116uy then
              let! is_this = (fun () -> keyword input start_pos 4ul 0x74686973uL) in
              if is_this then ret input (4ul) else (let! anf_value_17 = (fun () -> keyword input start_pos 4ul 0x74727565uL) in if anf_value_17 then ret input (4ul) else ret input (0ul))
            else if ch = 102uy then ((let! anf_value_18 = (fun () -> keyword input start_pos 5ul 0x66616c7365uL) in if anf_value_18 then ret input (5ul) else ret input (0ul)))
            else if ch = 110uy then ((let! anf_value_19 = (fun () -> keyword input start_pos 4ul 0x6e756c6cuL) in if anf_value_19 then ret input (4ul) else ret input (0ul)))
            else ret input (0ul)) in
          if width <> 0ul then ret input (({ st with offset = plus start_pos width }, NotAssignable))
          else
            let! name_ = (fun () -> name input start_pos false false) in
            let named = from_cursor st name_ in
            let! named = (fun () -> if ch = 97uy || ch = 110uy || ch = 115uy || ch = 116uy then
              record_contextual_reference input named start_pos ch else ret input named) in
            let! target = (fun () -> identifier_target input start_pos ch) in
            ret input (named, target)) in
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
    class_tail input named (minus fuel 1ul) OrdinaryClass
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
  let! completed = (fun () -> if input.capture_types && byte = 40uy then
    record_jsx_span input completed 27ul start_pos completed.offset else ret input completed) in
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
  else (let! anf_value_4 = (fun () -> spread_at input st.offset) in if anf_value_4 then
    // A rest parameter may be a pattern, as in (...[head, ...tail]: Params) => head.
    let! target = (fun () -> skip input { st with offset = plus st.offset 3ul }) in
    let! opener = (fun () -> peek input target.offset) in
    if opener <> 91uy && opener <> 123uy then rest_parameter input st floor used
    else if fuel = 0ul then ret input ({ names = { state = failed st 3ul; used }; non_simple })
    else
      let! bound = (fun () -> pattern_binding input { target with await_allowed = false; yield_allowed = false }
        binding_region_width floor used (minus fuel 1ul)) in
      let typed = { bound.state with await_allowed = st.await_allowed; yield_allowed = st.yield_allowed } in
      let! end_ = (fun () -> (let! annotated = (fun () -> ((let! captured = (fun () -> (capture_annotation input typed false)) in skip input captured))) in consume input annotated 41uy)) in
      ret input ({ names = { bound with state = end_ }; non_simple = true })
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
  let missed = missed_arrow state in
  if state.status <> 0ul then ret input (missed)
  else
    let! byte = (fun () -> peek input state.offset) in
    if G.identifier_start byte then bare_arrow_parameters input state
    else
    let! opening = (fun () -> if byte = 60uy then
      let! generic = (fun () -> generic_arrow_head input state) in
      let! recorded = (fun () -> record_jsx_span input generic 16ul state.offset generic.offset) in
      skip input recorded
      else ret input state) in
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
      let! body = (fun () -> arrow_token input result) in
      let! body = (fun () -> if input.capture_types && colon && not after.newline then
        let span = { G.first = st.offset; G.last = result.offset } in
        let closing = { G.first = minus params.names.state.offset 1ul; G.last = params.names.state.offset } in
        record_compiler_span input body 20ul span closing else ret input body) in
      ret input ({ params with names = { params.names with state = body } })
    else ret input (missed)

and arrow_parameters (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 24; 0]) =
  let normal = { state with await_allowed = false } in
  if state.status <> 0ul then ret input (missed_arrow normal)
  else
    let! byte = (fun () -> peek input state.offset) in
    if byte = 97uy then
      let! modifier = (fun () -> async_modifier input state.offset) in
      if modifier.ok then
        let! async_ = (fun () -> plain_arrow_parameters input { state with offset = modifier.at; await_allowed = true } fuel) in
        if async_.names.state.status = 0ul || async_.names.state.status = 4ul then ret input async_
        else plain_arrow_parameters input normal fuel
      else plain_arrow_parameters input normal fuel
    else if byte = 40uy || byte = 60uy then plain_arrow_parameters input normal fuel
    else if G.identifier_start byte then bare_arrow_parameters input normal
    else ret input (missed_arrow normal)

and comparison (input:tape) (current:parser_state) (fuel:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 25; 0]) =
  let! start = (fun () -> skip input current) in
  let! first = (fun () -> peek input start.offset) in
  let! yielding = (fun () -> if first = 121uy && start.yield_allowed then keyword input start.offset 5ul 0x7969656c64uL else ret input (false)) in
  if yielding then
    // A yield takes an optional operand. A star before the operand delegates, and the star stays on the keyword's line.
    let head = plus start.offset 5ul in
    let! after = (fun () -> trivia input head) in
    let! byte = (fun () -> peek input after.at) in
    let bare = { (empty_range (from_cursor start after)) with range = { G.first = start.offset; G.last = head } } in
    if not after.ok || after.newline || byte = 59uy || byte = 125uy || byte = 41uy || byte = 93uy || byte = 44uy || byte = 58uy then ret input (bare)
    else if fuel = 0ul then ret input (empty_range (failed start 3ul))
    else
      let! operand =
        (fun () -> if byte = 42uy then
          let! delegated = (fun () -> trivia input (next after.at)) in
          // The reference parsers reject a line break between the star and its operand.
          ret input (if delegated.newline then failed start 1ul else from_cursor start delegated)
        else ret input (from_cursor start after)) in
      let! value = (fun () -> comparison input operand (minus fuel 1ul)) in
      ret input ({ value with range = { value.range with G.first = start.offset }; outer_or = false; shortcut = 0ul; target = NotAssignable })
  else
  let! arrow = (fun () -> arrow_parameters input { start with yield_allowed = false } fuel) in
  if arrow.names.state.status = 0ul then
    let! body = (fun () -> skip input (enter_function_locals { arrow.names.state with local_names = arrow.names.used })) in
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
      ret input ({ result with parser = leave_function_locals { result.parser with local_names = start.local_names; await_allowed = start.await_allowed;
          yield_allowed = start.yield_allowed; in_allowed = start.in_allowed } start;
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
  let! st = (fun () -> skip input lhs.parser) in
  binary_tail input { lhs with parser = st } fuel minimum input.size
and binary_tail (input:tape) (lhs:parsed) (fuel:U32.t) (minimum:precedence) (remaining:U32.t)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 25 - U32.v minimum - U32.v minimum; U32.v remaining]) =
  let st = lhs.parser in
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
        let! suffix = (fun () -> if asserted.status = 0ul then trivia input asserted.offset
          else ret input { at = asserted.offset; ok = false; newline = false }) in
        (let! anf_value_3 = (fun () -> ambiguous_assertion_update input (from_cursor asserted suffix)) in if anf_value_3 then ret input (empty_range (failed asserted 1ul))
        else
          let span = { G.first = st.offset; G.last = asserted.offset } in
          // A nonempty context span marks a line terminator before the next token.
          let context = { G.first = if suffix.newline then asserted.offset else suffix.at; G.last = suffix.at } in
          let! asserted = (fun () -> record_compiler_span input asserted 11ul span context) in
          let target = if can_assign_expression lhs.target then AssertedTarget else NotAssignable in
          let value = { lhs with parser = from_cursor asserted suffix; range = { lhs.range with G.last = asserted.offset };
            outer_or = false; target } in
          binary_tail input value fuel minimum (minus remaining 1ul))
    else
      let! op = (fun () -> operator input st.offset st.in_allowed) in
      let reserve = op.boundary <> 0ul && not input.capture_types in
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
      else if reserve && not input.count_only && U32.(st.count >=^ input.capacity) then ret input (empty_range (failed st 4ul))
      else
        let count = if reserve then next st.count else st.count in
        let after = { st with offset = plus st.offset op.width; count } in
        let! rhs = (fun () -> if exponent then binary input after (minus fuel 1ul) op.strength
          else binary input after fuel (U32.add op.strength 1ul)) in
        let! shift_ambiguity = (fun () -> if not st.jsx_allowed && first = 60uy && op.strength = 8ul && rhs.parser.status = 0ul then
          left_shift_type_ambiguity input after rhs.parser else ret input false) in
        if shift_ambiguity then ret input (empty_range (failed rhs.parser 1ul))
        else
          let! combined = (fun () -> combine_binary input lhs rhs st op first reserve) in
          if combined.parser.status <> 0ul then ret input (combined)
          else
            let! after = (fun () -> skip input combined.parser) in
            binary_tail input { combined with parser = after } fuel minimum (minus remaining 1ul)

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
      let! after = (fun () -> record_jsx_span input head.after_types 10ul st.offset head.after_types.offset) in
      ret input ({ base with parser = after; range = { base.range with G.last = after.offset }; target = NotAssignable })
    else if increment <> 0ul then
      // A non-null assertion keeps its operand assignable, so x!++ updates x.
      ret input (if not (can_assign_expression base.target) then empty_range (failed st 1ul)
      else
        let end_at = plus st.offset increment in
        { base with parser = { st with offset = end_at }; range = { base.range with G.last = end_at };
          target = NotAssignable })
    else if byte <> 46uy && byte <> 40uy && byte <> 91uy && byte <> 96uy &&
      not bang && not optional && not typed then ret input ({ base with parser = st })
    else if remaining = 0ul then ret input (empty_range (failed st 3ul))
    else
      let! operand =
        (fun () -> if typed then
          let! typed = (fun () -> record_jsx_span input head.after_types 10ul st.offset head.after_types.offset) in
          skip input typed
        else if optional then
          let! after = (fun () -> skip input { st with offset = plus st.offset 2ul }) in
          (let! anf_value_1 = (fun () -> same input after.offset 60uy) in if anf_value_1 then call_type_arguments input after else ret input (after))
        else ret input (st)) in
      let! kind = (fun () -> if typed || optional then peek input operand.offset else ret input (byte)) in
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
              let! tail = (fun () -> template_body input inside operand.offset (minus fuel 1ul) input.size true) in ret input (tail, false)
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
        else
          let tail = { st with offset = next st.offset } in
          let! tail = (fun () -> if bang then record_jsx_span input tail 12ul st.offset tail.offset else ret input tail) in
          ret input (tail, false)) in
      let target =
        if optional || base.target = OptionalChain then OptionalChain
        else if bang && can_assign_expression base.target then AssertedTarget
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
  : Tot (stt expression_items (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; 2 * U32.v remaining + 1]) =
  expression_run input state fuel remaining close valid_array_target 0ul
// The items of a call or of an array literal. The function calls itself only in tail position and is
// extracted as a loop: a list of tens of thousands of items must not use the C stack.
//
// TypeScript tries a type argument list at a less-than sign and takes it only if the list ends in a
// greater-than sign before the bracket that closes these items. `angled` is one more than the offset of the
// first item whose comparison could start such a list, or zero. When the bracket is reached, the text from that
// item to the bracket is searched for a greater-than sign that is not the head of an arrow.
and expression_run (input:tape) (state:parser_state) (fuel remaining:U32.t) (close:U8.t) (valid_array_target:bool) (angled:U32.t)
  : Tot (stt expression_items (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; 2 * U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ list_end = st; valid_array_target = false })
  else (let! anf_value_1 = (fun () -> same input st.offset close) in if anf_value_1 then
    (let! anf_value_2 = (fun () -> consume input st close) in expression_end input anf_value_2 valid_array_target angled)
  else if remaining = 0ul then ret input ({ list_end = failed st 3ul; valid_array_target = false })
  else
    let! hole = (fun () -> if close = 93uy then same input st.offset 44uy else ret input (false)) in
    if hole then (let! anf_value_3 = (fun () -> (consume input st 44uy)) in expression_run input anf_value_3 fuel (minus remaining 1ul) close valid_array_target angled)
    else
      let! spread = (fun () -> spread_at input st.offset) in
      let start = if spread then { st with offset = plus st.offset 3ul } else st in
      let! arg = (fun () -> comparison input start fuel) in
      let! st = (fun () -> skip input arg.parser) in
      let valid_array_target = valid_array_target && not spread && can_assign arg.target in
      (let! anf_value_4 = (fun () -> same input st.offset 44uy) in if anf_value_4 then
        let! next_item = (fun () -> consume input st 44uy) in
        let! disambiguated = (fun () -> if arg.open_angle then
          let! following = (fun () -> skip input next_item) in
          let stop = if close = 93uy then 44uy else close in
          let! ended = (fun () -> same input following.offset stop) in
          if ended || close <> 41uy || spread then ret input ended
          else
            let! simple = (fun () -> simple_less_argument input start st) in
            if simple then type_arguments_end_at_call_close input following 32ul else ret input false
          else ret input (false)) in
        let! angled = (fun () -> if arg.open_angle && not disambiguated && angled = 0ul then
            first_less_from input start.offset st.offset start.offset (minus st.offset start.offset)
          else ret input angled) in
        expression_run input next_item fuel (minus remaining 1ul) close valid_array_target angled
      else (let! anf_value_5 = (fun () -> consume input st close) in expression_end input anf_value_5 valid_array_target angled)))
and object_member (input:tape) (st:parser_state) (fuel:U32.t) (colon_required seen_prototype:bool)
  : Tot (stt object_item (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; 0]) =
  let! spread = (fun () -> spread_at input st.offset) in
  if spread && not colon_required then
    let! value = (fun () -> comparison input { st with offset = plus st.offset 3ul } fuel) in
    ret input { value; prototype_setter = false }
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
    let! end_key, proto_spelling =
      (fun () -> if computed then
        let! key = (fun () -> comparison input { key_start with offset = next key_start.offset; in_allowed = true } fuel) in
        let! closed = (fun () -> (let! anf_value_1 = (fun () -> (skip input key.parser)) in consume input anf_value_1 93uy)) in
        ret input ({ closed with in_allowed = st.in_allowed }, false)
      else
        let! key =
          (fun () -> if numeric then number_end input key_start.offset
          else property_name input key_start) in
        let first = if quoted then next key_start.offset else key_start.offset in
        let last = if quoted then minus key.at 1ul else key.at in
        let! prototype = (fun () -> if key.ok && not accessor then proto_key input first last else ret input (false)) in
        ret input (from_cursor key_start key, prototype)) in
    let! after_key = (fun () -> skip input end_key) in
    let! colon = (fun () -> same input after_key.offset 58uy) in
    let assigning = colon && not async_method && not accessor && not generator.generator in
    let prototype_setter = assigning && proto_spelling in
    let! value = (fun () ->
      if after_key.status <> 0ul then ret input (empty_range after_key)
      else if prototype_setter && seen_prototype then ret input (empty_range (failed st 1ul))
      else if assigning then (let! anf_value_2 = (fun () -> consume input after_key 58uy) in comparison input anf_value_2 fuel)
      else
        let! next_token = (fun () -> peek input after_key.offset) in
        if not colon_required && (next_token = 40uy || next_token = 60uy) then
          if fuel = 0ul then ret input (empty_range (failed after_key 3ul))
          else if accessor || generator.generator then
            let! form = (fun () -> function_form input after_key (minus fuel 1ul) async_method MethodSuper false arity generator.generator) in
            ret input (empty_range form.after_function)
          else (let! anf_value_5 = (fun () -> function_tail input after_key (minus fuel 1ul) async_method NoSuper) in ret input (empty_range anf_value_5))
        else if computed || quoted || numeric || colon_required || async_method || accessor || generator.generator then ret input (empty_range (failed st 1ul))
        else
          let! shorthand = (fun () -> name input st.offset false false) in
          let! forbidden = (fun () -> forbidden_field_arguments input st) in
          ret input (if shorthand.ok && not forbidden then empty_range after_key else empty_range (failed st 1ul))) in
    ret input { value; prototype_setter }
// The members of an assignment pattern with defaults: names, renamed names, a default behind either, and a
// rest name at the end. Nested patterns are left to TypeScript.
and cover_assignment_members (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 60; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  let! closing = (fun () -> same input st.offset 125uy) in
  if st.status <> 0ul || closing then consume input st 125uy
  else if remaining = 0ul then ret input (failed st 1ul)
  else
    let! spread = (fun () -> spread_at input st.offset) in
    if spread then
      let! rest = (fun () -> skip input { st with offset = plus st.offset 3ul }) in
      // A target is a name that may be assigned in strict code: not eval, arguments or a reserved word.
      let! named = (fun () -> name input rest.offset false true) in
      let! tail = (fun () -> skip input (from_cursor rest named)) in
      consume input tail 125uy
    else
      let! key = (fun () -> name input st.offset false false) in
      let! tail = (fun () -> skip input (from_cursor st key)) in
      let! renamed = (fun () -> same input tail.offset 58uy) in
      let! target = (fun () -> if renamed then
          let! colon = (fun () -> (let! after = (fun () -> consume input tail 58uy) in skip input after)) in
          let! named = (fun () -> name input colon.offset false true) in
          skip input (from_cursor colon named)
        else
          // Without a rename the key is the target.
          let! assignable = (fun () -> name input st.offset false true) in
          ret input (if assignable.ok && assignable.at = key.at then tail else failed tail 1ul)) in
      let! defaulted = (fun () -> same input target.offset 61uy) in
      let! follower = (fun () -> if defaulted then peek input (next target.offset) else ret input 0uy) in
      let! valued = (fun () -> if defaulted && follower <> 61uy && follower <> 62uy then
          (let! value = (fun () -> comparison input { target with offset = next target.offset } fuel) in skip input value.parser)
        else ret input target) in
      let! comma = (fun () -> same input valued.offset 44uy) in
      if valued.status <> 0ul then ret input valued
      else if comma then cover_assignment_members input { valued with offset = next valued.offset } fuel (minus remaining 1ul)
      else consume input valued 125uy
and object_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (colon_required seen_prototype:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 27; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  let! byte = (fun () -> peek input st.offset) in
  if st.status <> 0ul then ret input (st)
  else if byte = 125uy then consume input st 125uy
  else if remaining = 0ul then ret input (failed st 3ul)
  else
    let! member = (fun () -> object_member input st fuel colon_required seen_prototype) in
    let value = member.value in
    let! st = (fun () -> skip input value.parser) in
    (let! anf_value_1 = (fun () -> same input st.offset 44uy) in if anf_value_1 then
      // A colon in the next property rules out a generic argument list across the comma.
      (let! anf_value_2 = (fun () -> (consume input st 44uy)) in object_members input anf_value_2 fuel (minus remaining 1ul)
        value.open_angle (seen_prototype || member.prototype_setter))
    else consume input st 125uy)
and template_body (input:tape) (state:parser_state) (raw_start fuel remaining:U32.t) (tagged:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 26; U32.v remaining]) =
  if state.status <> 0ul then ret input (state)
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then ret input (failed state 1ul)
  else
    let at = state.offset in
    let! byte = (fun () -> peek input at) in
    let! following = (fun () -> peek input (next at)) in
    if byte = 96uy then
      let stop = next at in
      record_jsx_span input { state with offset = stop } 17ul raw_start stop
    else if byte = 36uy && following = 123uy then
      let stop = plus at 2ul in
      let! before = (fun () -> record_jsx_span input { state with offset = stop; in_allowed = true } 17ul raw_start stop) in
      let! value = (fun () -> comparison input before fuel) in
      let! closed = (fun () -> consume input { value.parser with in_allowed = state.in_allowed } 125uy) in
      template_body input closed closed.offset fuel (minus remaining 1ul) tagged
    else
      let! st =
        (fun () -> if byte = 92uy then
          // Tagged templates may contain invalid cooked escapes. Only the next
          // byte can escape a template delimiter, regardless of cooked value.
          if tagged then ret input ({ state with offset = plus at 2ul })
          else (let! anf_value_1 = (fun () -> (escape_end input at true true)) in ret input (from_cursor state anf_value_1))
        else ret input ({ state with offset = next at })) in
      template_body input st raw_start fuel (minus remaining 1ul) tagged

and jsx_attribute (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 30; 0]) =
  let! first = (fun () -> peek input state.offset) in
  if first = 123uy then
    let! inner = (fun () -> (let! anf_value_1 = (fun () -> (consume input state 123uy)) in skip input anf_value_1)) in
    let! spread = (fun () -> spread_at input inner.offset) in
    if not spread then ret input (failed inner 1ul)
    else
      let! start = (fun () -> skip input { inner with offset = plus inner.offset 3ul }) in
      let! value = (fun () -> comparison input start fuel) in
      let! end_ = (fun () -> skip input value.parser) in
      finish_jsx_expression input end_ start.offset
  else
    let! named = (fun () -> jsx_attribute_name input state.offset) in
    let named_state = from_cursor state named in
    let! tail = (fun () -> skip input named_state) in
    let! equal = (fun () -> same input tail.offset 61uy) in
    if named_state.status <> 0ul || not equal then ret input (named_state)
    else
      let! st = (fun () -> (let! anf_value_3 = (fun () -> (consume input tail 61uy)) in skip input anf_value_3)) in
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
          let! next_attr = (fun () -> skip input nested) in
          let! first = (fun () -> peek input next_attr.offset) in
          ret input (if fragment && G.identifier_start first then failed nested 1ul else nested)
      else
        let! start = (fun () -> (let! opened = (fun () -> consume input st 123uy) in skip input opened)) in
        let! value = (fun () -> comparison input start fuel) in
        let! st = (fun () -> skip input value.parser) in
        // Delegate the focused rewrite for a direct disabled disjunction.
        let! disabled = (fun () -> if value.outer_or && minus named.at state.offset = 8ul then
          let! attr_name = (fun () -> word input state.offset 8ul 0uL) in ret input (attr_name = 0x64697361626c6564uL)
          else ret input (false)) in
        // The extractor delegates this form to its focused rewrite. The compiler lowers it like any attribute.
        if disabled && not input.capture_types then ret input (failed st 1ul) else finish_jsx_expression input st start.offset

and jsx_attributes (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt jsx_opening (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 31; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
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
          let! end_ = (fun () -> skip input value.parser) in
          finish_jsx_expression input end_ st.offset)) in
      jsx_children input done_ tag fuel (minus remaining 1ul)
    else if byte = 0uy || byte = 62uy || byte = 125uy then ret input (failed state 1ul)
    else jsx_children input { state with offset = next state.offset } tag fuel (minus remaining 1ul)

and jsx_element (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 33; 0]) =
  let depth = minus 64ul fuel in
  let state = if U32.(depth >^ state.depth) then { state with depth } else state in
  let! opening = (fun () -> (let! anf_value_1 = (fun () -> (consume input state 60uy)) in tag_space input anf_value_1)) in
  let! ended = (fun () ->
    let! fragment = (fun () -> same input opening.offset 62uy) in
    if fragment then
      let! children = (fun () -> consume input opening 62uy) in
      jsx_children input children (start_range opening.offset) fuel input.size
    else
      let! named = (fun () -> jsx_tag_name input opening.offset 64ul) in
      let! attrs = (fun () -> jsx_attributes input (from_cursor opening named) fuel input.size) in
      if attrs.after_tag.status <> 0ul || attrs.self_closing then ret input attrs.after_tag
      else jsx_children input attrs.after_tag { G.first = opening.offset; G.last = named.at } fuel input.size) in
  record_jsx_span input ended 0ul state.offset ended.offset

and condition (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 43; 0]) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (skip input state)) in consume input anf_value_1 40uy)) in
  let! tested = (fun () -> comparison input st fuel) in
  (let! anf_value_2 = (fun () -> (skip input tested.parser)) in consume input anf_value_2 41uy)

and declarator_value (input:tape) (state:parser_state) (fuel:U32.t) (optional:bool)
  : Tot (stt parsed (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 42; 0]) =
  let! after_name = (fun () -> trivia input state.offset) in
  let tail = from_cursor state after_name in
  if tail.status <> 0ul then ret input (empty_range tail)
  else
    let! byte = (fun () -> peek input tail.offset) in
    if optional && not after_name.newline && byte = 33uy then
      let! bang = (fun () -> consume input tail 33uy) in
      let! bang = (fun () -> record_jsx_span input bang 12ul tail.offset bang.offset) in
      let! colon = (fun () -> skip input bang) in
      let! annotation = (fun () -> (let! anf_value_2 = (fun () -> (consume input colon 58uy)) in annotation_type input anf_value_2 16ul 64ul)) in
      let! annotation = (fun () -> record_jsx_span input annotation 7ul colon.offset annotation.offset) in
      let! next_token = (fun () -> skip input annotation) in
      (let! anf_value_3 = (fun () -> same input next_token.offset 61uy) in if anf_value_3 then ret input (empty_range (failed next_token 1ul))
      else ret input (empty_range annotation))
    else
      let! annotation = (fun () -> if byte = 58uy then (let! anf_value_4 = (fun () -> (consume input tail 58uy)) in annotation_type input anf_value_4 16ul 64ul) else ret input (state)) in
      let! annotation = (fun () -> if input.capture_types && byte = 58uy then
        record_jsx_span input annotation 7ul tail.offset annotation.offset else ret input annotation) in
      let! st = (fun () -> if byte = 58uy then skip input annotation else ret input (tail)) in
      (let! anf_value_5 = (fun () -> same input st.offset 61uy) in if anf_value_5 then
        (let! anf_value_6 = (fun () -> (consume input st 61uy)) in comparison input anf_value_6 fuel)
      else ret input (if optional then empty_range annotation
      else empty_range (failed st 1ul)))

and binding (input:tape) (state:parser_state) (fuel:U32.t) (in_allowed:bool) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 43; 0]) =
  let! st = (fun () -> skip input state) in
  let! st = (fun () -> read_local_var_name input st) in
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
    let! tracked = (fun () -> record_local_pattern input declared.state st.local_names declared.used) in
    let! annotated = (fun () -> capture_annotation input { tracked with local_names = declared.used } false) in
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

and function_var_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (classic:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul || remaining = 0ul then ret input (failed st 1ul)
  else
    let! first = (fun () -> peek input st.offset) in
    let destructured = first = 91uy || first = 123uy in
    let! named = (fun () -> if destructured then
      let mark = st.local_names in
      let! bound = (fun () -> pattern_binding input st binding_region_width mark mark fuel) in
      record_local_pattern_kind input bound.state mark bound.used LocalVarName
      else read_local_var_name input st) in
    let! value = (fun () -> declarator_value input { named with in_allowed = state.in_allowed && not classic;
      for_initializer = state.for_initializer || classic } fuel (not destructured)) in
    let restored = { value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer } in
    let! tail = (fun () -> skip input restored) in
    let! comma = (fun () -> same input tail.offset 44uy) in
    if tail.status <> 0ul then ret input tail
    else if not comma then
      if classic then ret input tail else statement_end input restored value.range.G.last true
    else if value.open_angle then ret input (failed tail 1ul)
    else
      let! next_item = (fun () -> consume input tail 44uy) in
      function_var_list input next_item fuel (minus remaining 1ul) classic

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
      if local_var then function_var_list input { (record_binding_mode st VarLocals) with offset = plus st.offset 3ul } fuel 64ul true
      else binding input { st with offset = plus st.offset 3ul } fuel false
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
  let! found, collection = (fun () -> collection_head input st (not async_) local_var fuel) in
  if found then
    let! value = (fun () -> comparison input collection fuel) in
    (let! anf_value_2 = (fun () -> (skip input value.parser)) in consume input anf_value_2 41uy)
  else if async_ then ret input (collection)
  else classic_for_header input st top_level local_var fuel

and return_statement (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let after = plus state.offset 6ul in
  let! body = (fun () -> trivia input after) in
  let st = from_cursor state body in
  let! byte = (fun () -> peek input st.offset) in
  if byte = 59uy || byte = 125uy || body.newline then statement_end input st after true
  else statement_expressions input st fuel input.size

and statement_expressions (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; U32.v remaining]) =
  if remaining = 0ul then ret input (failed state 1ul)
  else
    let! value = (fun () -> comparison input state fuel) in
    let! comma = (fun () -> same input value.parser.offset 44uy) in
    if value.parser.status <> 0ul || not comma then statement_end input value.parser value.range.G.last true
    else if value.open_angle then ret input (failed value.parser 1ul)
    else
      let! next_value = (fun () -> consume input value.parser 44uy) in
      statement_expressions input next_value fuel (minus remaining 1ul)

and ordinary_statement (input:tape) (state:parser_state) (fuel:U32.t) : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let! function_head = (fun () -> function_start input state.offset) in
  let! block = (fun () -> same input state.offset 123uy) in
  let! first = (fun () -> peek input state.offset) in
  let! class_ = (fun () -> if first = 99uy then class_keyword input state.offset else ret input (false)) in
  let! global_ = (fun () -> if first = 103uy then keyword input state.offset 6ul 0x676c6f62616cuL else ret input false) in
  // TypeScript reads `global` before a block or a name as a declaration, even across a line break.
  let! augmentation = (fun () -> if not global_ then ret input false
    else
      let! after = (fun () -> trivia input (plus state.offset 6ul)) in
      let! follower = (fun () -> peek input after.at) in
      ret input (not after.ok || follower = 123uy || G.identifier_start follower)) in
  // It also rejects these words before a name or a string on the same line, where JavaScript has an expression.
  let! modifier_width = (fun () ->
    if first = 110uy then
      let! prefix = (fun () -> word input state.offset 8ul 0uL) in
      let! found = (fun () -> if prefix = 0x6e616d6573706163uL then keyword input (plus state.offset 8ul) 1ul 0x65uL else ret input false) in
      ret input (if found then 9ul else 0ul)
    else if first = 109uy then (let! found = (fun () -> keyword input state.offset 6ul 0x6d6f64756c65uL) in ret input (if found then 6ul else 0ul))
    else if first = 114uy then (let! found = (fun () -> keyword input state.offset 8ul 0x726561646f6e6c79uL) in ret input (if found then 8ul else 0ul))
    else if first = 97uy then (let! found = (fun () -> keyword input state.offset 8ul 0x6163636573736f72uL) in ret input (if found then 8ul else 0ul))
    else ret input 0ul) in
  let! declaration_like = (fun () -> if modifier_width = 0ul then ret input false
    else
      let! after = (fun () -> trivia input (plus state.offset modifier_width)) in
      let! follower = (fun () -> peek input after.at) in
      ret input (not after.ok || (not after.newline && (G.identifier_start follower || follower = 34uy || follower = 39uy)))) in
  if block || function_head.ok || class_ || augmentation || declaration_like then ret input (failed state 1ul)
  else statement_expressions input state fuel input.size

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
  let! is_debugger = (fun () -> if byte = 100uy then keyword input state.offset 8ul 0x6465627567676572uL else ret input (false)) in
  if is_return then return_statement input state fuel
  else if is_yield then statement_expressions input state fuel input.size
  else if is_debugger then
    let after = plus state.offset 8ul in
    let! body = (fun () -> trivia input after) in
    statement_end input (from_cursor state body) after true
  else if jump <> 0ul then jump_statement input state jumps jump
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
  function_var_list input { st with offset = plus st.offset 3ul } fuel 64ul false

and local_declarators (input:tape) (state:parser_state) (constant names_only:bool) (floor used:names_used) (fuel remaining angled:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 44; U32.v remaining]) =
  let! start = (fun () -> skip input state) in
  if start.status <> 0ul || remaining = 0ul then ret input ({ state = failed start 1ul; used })
  else
    let! first = (fun () -> peek input start.offset) in
    let! decl = (fun () -> if names_only then bind_pattern_name input start binding_region_width floor used start.offset
      else pattern_binding input start binding_region_width floor used fuel) in
    let! tracked = (fun () -> record_local_pattern input decl.state used decl.used) in
    let named = { tracked with local_names = decl.used } in
    let! value = (fun () -> declarator_value input named fuel (not constant && G.identifier_start first)) in
    let! tail = (fun () -> skip input value.parser) in
    if tail.status <> 0ul then ret input ({ decl with state = tail })
    else (let! anf_value_1 = (fun () -> (let! anf_value_2 = (fun () -> (same input tail.offset 44uy)) in ret input (not anf_value_2))) in if anf_value_1 then
      (let! anf_value_3 = (fun () -> (let! ended = (fun () -> statement_end input value.parser value.range.G.last true) in declarators_end input ended angled)) in
        ret input ({ decl with state = anf_value_3 }))
    else
      let! angled = (fun () -> if value.open_angle && angled = 0ul then
          first_less_from input start.offset tail.offset start.offset (minus tail.offset start.offset)
        else ret input angled) in
      (let! anf_value_4 = (fun () -> (consume input tail 44uy)) in local_declarators input anf_value_4 constant names_only floor decl.used fuel (minus remaining 1ul) angled))

and local_declaration (input:tape) (state:parser_state) (width:U32.t) (floor used:names_used) (fuel:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 45; 0]) =
  let state = record_binding_mode state LexicalLocals in
  local_declarators input { state with offset = plus state.offset width } (width <> 3ul) false floor used fuel input.size 0ul

and scope_statement (input:tape) (st:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (root_control allow_resource:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 48; 0]) =
  let! width = (fun () -> if root_control then ret input (0ul) else local_width input st.offset) in
  let! function_head = (fun () -> if root_control || not (st.module_mode || st.strict_script) then ret input ({ at = st.offset; ok = false; newline = false })
    else function_start input st.offset) in
  let! first = (fun () -> peek input st.offset) in
  let! class_ = (fun () -> if not root_control && st.module_mode && first = 99uy then class_keyword input st.offset
    else ret input false) in
  // An abstract class inside a function: the modifier is erased as it is at module level.
  let! abstract_ = (fun () -> if not root_control && st.module_mode && first = 97uy && input.capture_types then
    abstract_class_start input st.offset else ret input { at = st.offset; ok = false; newline = false }) in
  let! resource = (fun () -> if not root_control && allow_resource && (first = 117uy || first = 97uy && st.await_allowed) then
    resource_declaration_start input st first else ret input (failed st 1ul)) in
  // Every const declaration passes here, so one byte decides before the keyword is read: `const enum` with a
  // single space. Other spacing is left to the reference route.
  let! after_const = (fun () -> if width = 5ul && input.capture_types then peek input (plus st.offset 6ul) else ret input 0uy) in
  let! enumeration = (fun () -> if input.capture_types && not root_control && strict_locals st &&
      ((first = 101uy && width = 0ul) || after_const = 101uy) then
    local_enum_start input st.offset else ret input { at = st.offset; ok = false; newline = false }) in
  if enumeration.ok then local_enum_declaration input st enumeration.at floor used
  else if width <> 0ul then local_declaration input st width floor used fuel
  else if resource.status = 0ul then
    local_declarators input (record_binding_mode resource LexicalLocals) true true floor used fuel input.size 0ul
  else if function_head.ok then
    if fuel = 0ul then ret input ({ state = failed st 3ul; used })
    else
      let declared = record_binding_mode st LexicalLocals in
      let! named = (fun () -> skip input { declared with offset = plus function_head.at 8ul }) in
      let! head = (fun () -> read_generator_head input named) in
      let named = head.after_star in
      let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
      let! tracked = (fun () -> record_local_pattern input decl.state used decl.used) in
      let start = { tracked with local_names = decl.used } in
      let name_span = { G.first = named.offset; G.last = decl.state.offset } in
      let! after = (fun () -> local_function_group input start st.offset (minus fuel 1ul) (st.offset <> function_head.at)
        head.generator name_span 64ul) in
      ret input ({ decl with state = after })
  else if abstract_.ok then local_abstract_class input st abstract_.at floor used fuel
  else if class_ then
    if fuel = 0ul then ret input ({ state = failed st 3ul; used })
    else
      let declared = record_binding_mode st LexicalLocals in
      let! named = (fun () -> skip input { declared with offset = plus st.offset 5ul }) in
      let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
      let! tracked = (fun () -> record_local_pattern input decl.state used decl.used) in
      let start = { tracked with local_names = decl.used } in
      (let! anf_value_2 = (fun () -> class_tail input start (minus fuel 1ul) OrdinaryClass) in ret input ({ decl with state = anf_value_2 }))
  else
    let! type_width =
      (fun () -> if input.capture_types && not root_control && strict_locals st &&
        (first = 116uy || first = 105uy) then type_declaration_width input st.offset
      else ret input 0ul) in
    if type_width = 4ul || type_width = 9ul then
      let! declared = (fun () -> local_type_declaration input st type_width floor used) in
      let! recorded = (fun () -> record_jsx_span input declared.state 19ul st.offset declared.state.offset) in
      ret input { declared with state = recorded }
    else control_statement input st fuel in_function jumps floor used root_control

and local_abstract_class (input:tape) (st:parser_state) (class_at:U32.t) (floor used:names_used) (fuel:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 47; 0]) =
  if fuel = 0ul then ret input ({ state = failed st 3ul; used })
  else
    let! erased = (fun () -> record_jsx_span input st 15ul st.offset (plus st.offset 8ul)) in
    let declared = record_binding_mode erased LexicalLocals in
    let! named = (fun () -> skip input { declared with offset = plus class_at 5ul }) in
    let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
    let! tracked = (fun () -> record_local_pattern input decl.state used decl.used) in
    let start = { tracked with local_names = decl.used } in
    (let! closed = (fun () -> class_tail input start (minus fuel 1ul) AbstractClass) in ret input ({ decl with state = closed }))

and local_function_group (input:tape) (start:parser_state) (declaration_start fuel:U32.t) (async_ generator:bool) (expected:G.span) (remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 54; U32.v remaining]) =
  let! form = (fun () -> function_form input start fuel async_ NoSuper (start.module_mode && not generator) OrdinaryParameters generator) in
  let after = form.after_function in
  if after.status <> 0ul || not form.signature_only then ret input after
  else if remaining = 0ul then ret input (failed after 3ul)
  else
    let! after = (fun () -> record_jsx_span input { after with count = start.count } 21ul declaration_start after.offset) in
    let! following = (fun () -> skip input after) in
    let! head = (fun () -> function_start input following.offset) in
    if not head.ok || (following.offset <> head.at) <> async_ then ret input (failed following 1ul)
    else
      let! start = (fun () -> skip input { following with offset = plus head.at 8ul }) in
      let! named = (fun () -> name input start.offset false true) in
      let length = minus expected.G.last expected.G.first in
      let! matches = (fun () -> if named.ok && minus named.at start.offset = length then
        same_bytes input expected.G.first start.offset length else ret input false) in
      if not matches then ret input (failed start 1ul)
      else local_function_group input (from_cursor start named) following.offset fuel async_ false expected (minus remaining 1ul)

and control_sequence (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (root_control:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 49; U32.v remaining]) =
  let! st = (fun () -> skip input { state with local_names = used }) in
  let! closed = (fun () -> same input st.offset 125uy) in
  if st.status <> 0ul || st.offset = input.size || closed then ret input (st)
  else if remaining = 0ul then ret input (failed st 1ul)
  else
    let! statement = (fun () -> scope_statement input st fuel in_function jumps floor used root_control true) in
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
      let! statement = (fun () -> scope_statement input st fuel in_function jumps floor used false false) in
      switch_sequence input statement.state fuel left in_function jumps floor statement.used true seen_default
and control_block (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (floor used:names_used)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 51; 0]) =
  let! st = (fun () -> (let! anf_value_1 = (fun () -> (skip input state)) in consume input anf_value_1 123uy)) in
  let! st = (fun () -> control_sequence input { st with local_names = used } fuel input.size in_function jumps floor used false) in
  let! closed = (fun () -> consume input { st with local_names = state.local_names } 125uy) in
  finish_local_scope input closed state.local_log_used
and control_statement (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (allow_var:bool) : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 47; 0]) =
  let! kind = (fun () -> statement_kind input state.offset) in
  if state.status <> 0ul then ret input ({ state; used })
  else if kind = 0ul then
    // Outside functions a var is taken in a module, where its names are entered among the module's at the end,
    // and in a script that the compiler publishes, which V8 checks.
    let typed_local = in_function && strict_locals state in
    let local_var = typed_local || ((state.module_mode || (state.strict_script && input.capture_types)) && state.super_context = NoSuper) in
    let! first = (fun () -> peek input state.offset) in
    let! type_width = (fun () -> if typed_local && (first = 116uy || first = 105uy) then type_declaration_width input state.offset
      else ret input 0ul) in
    let! var = (fun () -> if local_var && first = 118uy then keyword input state.offset 3ul 0x766172uL else ret input (false)) in
    if type_width = 4ul || type_width = 9ul then
      let! declared = (fun () -> local_type_declaration input state type_width floor used) in
      // Only a block-level declaration is projected. Kind 29 withholds this one from publication.
      let! recorded = (fun () -> record_jsx_span input declared.state 29ul state.offset declared.state.offset) in
      ret input { declared with state = recorded }
    else if var then (let! anf_value_2 = (fun () -> local_var_declaration input state fuel) in ret input ({ state = anf_value_2; used }))
    else
      let! ordinary = (fun () -> simple_statement input state in_function jumps fuel) in
      let full = match jumps with | NestedNamedLoops _ _ -> true | _ -> false in
      if ordinary.status <> 1ul || fuel = 0ul || full then ret input { state = ordinary; used }
      else
        let! opening = (fun () -> labeled_loop_start input state) in
        if opening.status <> 0ul then ret input { state = ordinary; used }
        else
          let! context, valid = (fun () -> match jumps with
            | NamedLoop outer ->
              let! end_ = (fun () -> name input state.offset false false) in
              let! duplicate = (fun () -> same_label_name input outer state.offset end_.at) in
              ret input (NestedNamedLoops outer state.offset, not duplicate)
            | _ -> ret input (NamedLoop state.offset, true)) in
          if valid then control_statement input opening (minus fuel 1ul) in_function context floor used allow_var
          else ret input { state = ordinary; used }
  else if fuel = 0ul then ret input ({ state = failed state 3ul; used })
  else
    let inner = minus fuel 1ul in
    let depth = minus 65ul fuel in
    let state = if U32.(depth >^ state.depth) then { state with depth } else state in
    if kind = 1ul || kind = 2ul then
      let width = if kind = 1ul then 2ul else 5ul in
      let! tested = (fun () -> condition input { state with offset = plus state.offset width } fuel) in
      let body_jumps = if kind = 2ul then loop_jumps jumps else jumps in
      let! body = (fun () -> control_body input tested inner in_function body_jumps floor used) in
      let! st = (fun () -> skip input body.state) in
      let! has_else = (fun () -> if kind = 1ul then keyword input st.offset 4ul 0x656c7365uL else ret input (false)) in
      if has_else then
        control_body input { st with offset = plus st.offset 4ul } inner in_function jumps floor body.used
      else ret input ({ body with state = st })
    else if kind = 3ul then
      let! body = (fun () -> control_body input { state with offset = plus state.offset 2ul } inner in_function (loop_jumps jumps) floor used) in
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
          let! tested = (fun () -> for_header input { state with offset = plus state.offset 3ul } allow_var ((in_function && strict_locals state) || ((state.module_mode || (state.strict_script && input.capture_types)) && state.super_context = NoSuper)) fuel) in
          let! body = (fun () -> control_body input tested inner in_function (loop_jumps jumps) tested.local_names tested.local_names) in
          finish_local_scope input { body.state with local_names = state.local_names } state.local_log_used
        else if kind = 5ul then
          try_statement input { state with offset = plus state.offset 3ul } inner in_function jumps used
        else if kind = 6ul then control_block input state inner in_function jumps used used
        else
          let! tested = (fun () -> condition input { state with offset = plus state.offset 6ul } fuel) in
          let! start = (fun () -> (let! anf_value_6 = (fun () -> (skip input tested)) in consume input anf_value_6 123uy)) in
          let case_jumps = match jumps with | NoJump -> BreakOnly | _ -> jumps in
          let! st = (fun () -> switch_sequence input start inner input.size in_function case_jumps used used false false) in
          let! closed = (fun () -> consume input { st with local_names = state.local_names } 125uy) in
          finish_local_scope input closed state.local_log_used) in
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
    let! tracked = (fun () -> record_local_pattern input bound.state used bound.used) in
    let! annotated = (fun () -> (let! anf_value_3 = (fun () -> (capture_annotation input tracked false)) in skip input anf_value_3)) in
    let! body = (fun () -> consume input annotated 41uy) in
    let! closed = (fun () -> control_block input body fuel in_function jumps used bound.used) in
    finish_local_scope input closed state.local_log_used
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
      let receiver_end = plus st.offset 4ul in
      let! colon = (fun () -> skip input { st with offset = receiver_end }) in
      let! mark = (fun () -> peek input colon.offset) in
      let bare = mark = 41uy || mark = 44uy in
      let! typed = (fun () -> if not constructor && bare then ret input colon
        else (let! anf_value_4 = (fun () -> consume input colon 58uy) in annotation_type input anf_value_4 16ul 64ul)) in
      let! end_ = (fun () -> skip input typed) in
      let! comma = (fun () -> same input end_.offset 44uy) in
      if comma then
        let! after = (fun () -> consume input end_ 44uy) in
        // A constructor keeps its receiver. Kind 29 withholds certification from the projection.
        let! after = (fun () -> record_jsx_span input after (if constructor then 29ul else 14ul) st.offset after.offset) in
        function_parameters input after floor used fuel (minus remaining 1ul) non_simple constructor
      else
        let erasure_end = if bare then receiver_end else typed.offset in
        let! end_ = (fun () -> record_jsx_span input end_ (if constructor then 29ul else 14ul) st.offset erasure_end) in
        let! closed = (fun () -> consume input end_ 41uy) in
        ret input ({ names = { state = closed; used }; non_simple })
    else if spread then
      let! target = (fun () -> skip input { st with offset = plus st.offset 3ul }) in
      let! opener = (fun () -> peek input target.offset) in
      if opener <> 91uy && opener <> 123uy then rest_parameter input st floor used
      else
        let! bound = (fun () -> pattern_binding input { target with await_allowed = false; yield_allowed = false }
          binding_region_width floor used fuel) in
        let typed = { bound.state with await_allowed = st.await_allowed; yield_allowed = st.yield_allowed } in
        let! end_ = (fun () -> (let! annotated = (fun () -> ((let! captured = (fun () -> (capture_annotation input typed false)) in skip input captured))) in consume input annotated 41uy)) in
        ret input ({ names = { bound with state = end_ }; non_simple = true })
    else
      let! property, binding_end = (fun () -> if constructor then constructor_property input st else ret input (st, st.offset)) in
      let! st = (fun () -> if property.offset <> st.offset then
        record_compiler_span input property 23ul { G.first = st.offset; G.last = property.offset }
          { G.first = property.offset; G.last = binding_end } else ret input property) in
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
  let start = { start with super_context = FunctionBody; yield_allowed = false } in
  let! start = (fun () -> capture_type_parameters input start false) in
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
  let! annotation = (fun () -> if constructor then ret input (params.names.state) else capture_annotation input params.names.state true) in
  let! st = (fun () -> skip input annotation) in
  let! signature_only = (fun () -> if overload && st.status = 0ul then (let! anf_value_4 = (fun () -> (same input st.offset 123uy)) in ret input (not anf_value_4)) else ret input (false)) in
  let! closed =
    (fun () -> if signature_only then
      signature_end input state opening params annotation st constructor
    else
      let context = if super_ = NoSuper then FunctionBody else super_ in
      let st = enter_function_locals { st with await_allowed = async_; yield_allowed = generator; in_allowed = true; super_context = context } in
      (let! anf_value_5 = (fun () -> (function_body input st params.non_simple)) in control_block input anf_value_5 fuel true NoJump floor params.names.used)) in
  let! closed = (fun () -> if input.capture_types && constructor && not signature_only && params.names.state.count <> opening.count then
    record_compiler_span input closed (if super_ = BaseConstructor then 25ul else 26ul)
      { G.first = opening.offset; G.last = params.names.state.offset } { G.first = st.offset; G.last = closed.offset }
    else ret input closed) in
  ret input ({ after_function = leave_function_locals { closed with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed;
      in_allowed = state.in_allowed; super_context = state.super_context } state; signature_only })

and class_field_tail (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 55; 0]) =
  let! gap = (fun () -> trivia input state.offset) in
  let st = from_cursor state gap in
  let! byte = (fun () -> peek input st.offset) in
  let definite = byte = 33uy && not gap.newline in
  let optional = byte = 63uy && not gap.newline in
  let! head = (fun () -> if optional || definite then consume input st byte else ret input (state)) in
  let! head = (fun () -> if optional || definite then record_jsx_span input head 12ul st.offset head.offset else ret input head) in
  let! typed = (fun () -> simple_annotation input head) in
  let! after = (fun () -> skip input typed) in
  let! following = (fun () -> peek input after.offset) in
  let equal = following = 61uy in
  if definite && (equal || typed.offset = head.offset) then ret input (failed after 1ul)
  else
  let kind = if equal || following = 59uy || following = 125uy then 7ul else 22ul in
  let! typed = (fun () -> if kind = 22ul && optional && typed.offset = head.offset then
    record_jsx_span input { typed with count = state.count } 22ul st.offset head.offset
    else capture_parsed_annotation input head typed kind) in
  if not equal then statement_end input typed typed.offset true
  else
    let after = { after with count = typed.count; status = if typed.status <> 0ul then typed.status else after.status } in
    let! start = (fun () -> consume input { after with await_allowed = false; yield_allowed = false; super_context = ClassField; in_allowed = true } 61uy) in
    let! value = (fun () -> comparison input start fuel) in
    let! closed = (fun () -> statement_end input value.parser value.range.G.last true) in
    ret input ({ closed with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed;
      super_context = state.super_context; in_allowed = state.in_allowed })

// Decorators stay in the output as written. Each is a name, a member chain, or either followed by arguments.
// The result is positioned at the declaration that the decorators apply to.
and decorators (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 55; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  let! at_sign = (fun () -> same input st.offset 64uy) in
  if st.status <> 0ul || not at_sign then ret input st
  else if remaining = 0ul || fuel = 0ul then ret input (failed st 3ul)
  else
    let! named = (fun () -> name input (next st.offset) false false) in
    let! chain = (fun () -> qualified_name input (from_cursor st named) 16ul) in
    let! tail = (fun () -> skip input chain) in
    let! call = (fun () -> same input tail.offset 40uy) in
    let! applied = (fun () -> if tail.status <> 0ul || not call then ret input tail
      else
        let! arguments = (fun () -> expression_list input { tail with offset = next tail.offset } (minus fuel 1ul) input.size 41uy false) in
        ret input arguments.list_end) in
    decorators input applied fuel (minus remaining 1ul)

and class_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (derived seen_constructor:bool) (kind:class_kind) (pending:pending_overload)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 56; U32.v remaining]) =
  let! undecorated = (fun () -> skip input state) in
  let! st = (fun () -> decorators input undecorated fuel 16ul) in
  let decorated = st.offset <> undecorated.offset in
  let! byte = (fun () -> peek input st.offset) in
  let awaiting_body = pending.key_span.G.first <> pending.key_span.G.last in
  if st.status <> 0ul then ret input (st)
  // A decorator applies to a member with a body or a value. It cannot stand before the end of the class,
  // an empty member, a constructor or a signature that is erased.
  else if decorated && (byte = 125uy || byte = 59uy || awaiting_body || kind = AmbientClass) then ret input (failed st 1ul)
  else if byte = 125uy then
    if awaiting_body then ret input (failed st 1ul) else consume input st 125uy
  else if remaining = 0ul then ret input (failed st 1ul)
  else if byte = 59uy then
    if awaiting_body then ret input (failed st 1ul)
    else (let! anf_value_1 = (fun () -> consume input st 59uy) in class_members input anf_value_1 fuel (minus remaining 1ul) derived seen_constructor kind no_overload)
  else
    // An index signature, [key: string]: T, declares nothing at run time.
    let! indexed = (fun () -> if byte = 91uy && input.capture_types && not decorated && not awaiting_body then
      class_index_signature input st else ret input (failed st 1ul)) in
    if indexed.status = 0ul then
      let! recorded = (fun () -> if kind <> AmbientClass then record_jsx_span input { indexed with count = st.count } 21ul st.offset indexed.offset
        else ret input indexed) in
      class_members input recorded fuel (minus remaining 1ul) derived seen_constructor kind no_overload
    else
    let! member_head =
      (fun () -> if kind <> OrdinaryClass && (byte = 97uy || byte = 112uy) then
        let! modifier = (fun () -> abstract_member_modifier input st.offset byte) in
        let! has_key = (fun () -> if modifier.ok then class_key_start input { st with offset = modifier.at } else ret input false) in
        ret input (if has_key then { modifier with ok = true } else { modifier with at = st.offset; ok = false })
      else ret input { at = st.offset; ok = false; newline = false }) in
    let! key = (fun () -> class_member_key input { st with offset = member_head.at }) in
    let! tail = (fun () -> skip input key.after_key) in
    if tail.status <> 0ul then ret input (tail)
    else
      let! constructor_spelling = (fun () -> wide_key_matches input (if key.private_ then { key with first = next key.first } else key)
        3ul 0x636f6e7374727563uL 0x746f72uL) in
      let constructor_name = not key.private_ && not key.computed && constructor_spelling in
      let constructor = constructor_name && not key.static_ in
      let! prototype = (fun () -> if key.static_ && not key.computed then wide_key_matches input key 1ul 0x70726f746f747970uL 0x65uL else ret input (false)) in
      let! next_byte = (fun () -> peek input tail.offset) in
      let! optional_method = (fun () -> if st.module_mode && next_byte = 63uy then
          let! marker = (fun () -> trivia input key.after_key.offset) in
          let! following = (fun () -> trivia input (next tail.offset)) in
          let! open_ = (fun () -> peek input following.at) in
          ret input (if marker.ok && not marker.newline && following.ok && (open_ = 40uy || open_ = 60uy) then { tail with offset = following.at }
            else failed tail 1ul)
        else ret input (failed tail 1ul)) in
      let method = next_byte = 40uy || next_byte = 60uy in
      let accessor = key.arity <> OrdinaryParameters in
      let overload = method && U32.logand key.modifier_flags 2ul = 0ul && not member_head.ok && not key.computed &&
        not accessor && not key.private_ && not key.quoted_ && not key.generator_ in
      let! compatible = (fun () -> if not awaiting_body then ret input true else
          let length = minus key.last key.first in
          // An implementation may be async where its overload signatures are not.
          if overload && pending.key_flags = key.modifier_flags && (pending.key_async = key.async_ || not pending.key_async) &&
            length = minus pending.key_span.G.last pending.key_span.G.first then
            same_bytes input key.first pending.key_span.G.first length
          else ret input false) in
      if decorated && (U32.logand key.modifier_flags 16ul <> 0ul || member_head.ok || optional_method.status = 0ul || constructor_name) then
        ret input (failed tail 1ul)
      else if U32.logand key.modifier_flags 16ul <> 0ul then
        let! declared_first = (fun () -> keyword input st.offset 7ul 0x6465636c617265uL) in
        let! closed = (fun () -> if awaiting_body || kind = AmbientClass || not declared_first ||
          U32.logand key.modifier_flags 8ul <> 0ul || key.private_ || key.async_ || key.generator_ || accessor ||
          constructor_name || prototype then ret input (failed tail 1ul)
          else
            let! colon = (fun () -> if next_byte = 63uy then
              let! gap = (fun () -> trivia input key.after_key.offset) in
              if gap.newline then ret input (failed tail 1ul)
              else skip input { tail with offset = next tail.offset }
              else ret input tail) in
            let! annotation = (fun () -> consume input colon 58uy) in
            let! typed = (fun () -> annotation_type input annotation 16ul 64ul) in
            statement_end input typed typed.offset true) in
        let! closed = (fun () -> record_jsx_span input { closed with count = st.count } 21ul st.offset closed.offset) in
        class_members input closed fuel (minus remaining 1ul) derived seen_constructor kind no_overload
      else if member_head.ok || kind = AmbientClass then
        let ambient_constructor = kind = AmbientClass && constructor && not member_head.ok && next_byte = 40uy in
        let! closed =
          // An accessor is declared with its parameter list: get value: number is an error.
          (fun () -> if awaiting_body || (constructor_name && not ambient_constructor) || (accessor && (kind <> AmbientClass || not method)) ||
            key.private_ || key.quoted_ || key.computed || key.async_ || key.generator_ || prototype ||
            // A declared class is erased whole, so its members may be static or carry an access modifier.
            // An abstract member is erased whole, so it may also be marked override.
            (kind <> AmbientClass && U32.logand key.modifier_flags (U32.logor class_access_flags 1ul) <> 0ul) then ret input (failed tail 1ul)
          else if method then
            if fuel = 0ul || key.readonly_ then ret input (failed tail 1ul)
            else
              let mode = if ambient_constructor then BaseConstructor else MethodSuper in
              // A declared class may declare a getter: get name(): T;
              let! result = (fun () -> function_form input tail (minus fuel 1ul) false mode true key.arity false) in
              ret input (if result.signature_only then result.after_function else failed result.after_function 1ul)
          else
            // A declared class may mark a property optional.
            let! optional = (fun () -> if kind = AmbientClass then same input tail.offset 63uy else ret input false) in
            let! tail = (fun () -> if optional then (let! mark = (fun () -> consume input tail 63uy) in skip input mark) else ret input tail) in
            let! annotation = (fun () -> consume input tail 58uy) in
            let! typed = (fun () -> annotation_type input annotation 16ul 64ul) in
            let! following = (fun () -> skip input typed) in
            let! initializer = (fun () -> same input following.offset 61uy) in
            if initializer then ret input (failed following 1ul)
            else statement_end input typed typed.offset true) in
        let! closed = (fun () -> if kind <> AmbientClass then
          record_jsx_span input { closed with count = st.count } 21ul st.offset closed.offset else ret input closed) in
        class_members input closed fuel (minus remaining 1ul) derived seen_constructor kind no_overload
      else if optional_method.status = 0ul then
        let! closed = (fun () -> if awaiting_body || fuel = 0ul || constructor_name || prototype ||
          accessor || key.private_ || key.async_ || key.generator_ || key.readonly_ then ret input (failed tail 1ul)
          else
            let! result = (fun () -> function_form input optional_method (minus fuel 1ul) false MethodSuper true OrdinaryParameters false) in
            let after = result.after_function in
            if result.signature_only then record_jsx_span input { after with count = st.count } 21ul st.offset after.offset
            else ret input (failed after 1ul)) in
        class_members input closed fuel (minus remaining 1ul) derived seen_constructor kind no_overload
      else if not compatible || (key.private_ && constructor_spelling) || prototype || (constructor_name && not method) || (key.readonly_ && method) ||
        (accessor && (key.async_ || key.generator_ || constructor || next_byte <> 40uy)) ||
        (constructor && (seen_constructor || key.async_ || key.generator_ || next_byte <> 40uy)) then ret input (failed tail 1ul)
      else
        // Kind 30 marks modifiers behind a decorator, which need no separator from the member before.
        let! tail = (fun () -> if U32.logand key.modifier_flags 110ul <> 0ul then
          record_jsx_span input tail (if decorated then 30ul else 15ul) st.offset key.modifiers_end else ret input tail) in
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
              let after = if result.signature_only && decorated then failed result.after_function 1ul else result.after_function in
              let! after = (fun () -> if result.signature_only then
                record_jsx_span input { after with count = st.count } 21ul st.offset after.offset else ret input after) in
              ret input (after, pending)
          else if key.async_ || key.generator_ then ret input (failed tail 1ul, no_overload)
          else let! field = (fun () -> class_field_tail input { tail with offset = key.after_key.offset } fuel) in ret input (field, no_overload)) in
        class_members input after fuel (minus remaining 1ul) derived (seen_constructor || (constructor && pending.key_span.G.first = pending.key_span.G.last)) kind pending
and class_tail (input:tape) (state:parser_state) (fuel:U32.t) (kind:class_kind)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 57; 0]) =
  // A class, an interface and a type alias take variance annotations on their type parameters.
  let! st = (fun () -> capture_type_parameters input state true) in
  let! derived = (fun () -> keyword input st.offset 7ul 0x657874656e6473uL) in
  let! inherited =
    (fun () -> if not derived then ret input (st)
    else
      let! base = (fun () -> skip input { st with offset = plus st.offset 7ul }) in
      let! forbidden = (fun () -> forbidden_field_arguments input base) in
      let! head = (fun () -> read_atom_head input base) in
      // A heritage clause is a left-hand-side expression: a name, a member, a call, a parenthesized
      // expression. A unary operator cannot start it.
      if forbidden || head.prefix_ <> 0ul then ret input (failed base 1ul)
      else
        let! value = (fun () -> atom input base fuel) in
        let! tail = (fun () -> skip input value.parser) in
        let! angle = (fun () -> same input tail.offset 60uy) in
        // A postfix update is not a left-hand-side expression. It ends in a doubled sign.
        let! last = (fun () -> if U32.gte value.range.G.last 2ul then peek input (minus value.range.G.last 1ul) else ret input 0uy) in
        let! before = (fun () -> if U32.gte value.range.G.last 2ul then peek input (minus value.range.G.last 2ul) else ret input 0uy) in
        if tail.status = 0ul && (last = 43uy || last = 45uy) && before = last then ret input (failed tail 1ul)
        else if tail.status <> 0ul || not angle then ret input tail
        else
          // Type arguments after the expression belong to the heritage clause and are erased.
          let! typed = (fun () -> expression_type_arguments input tail) in
          let! recorded = (fun () -> if not input.capture_types || typed.status <> 0ul then ret input typed
            else record_jsx_span input typed 10ul tail.offset typed.offset) in
          skip input recorded) in
  let! word_ = (fun () -> word input inherited.offset 8ul 0uL) in
  let! implements = (fun () -> if word_ = 0x696d706c656d656euL then keyword input (plus inherited.offset 8ul) 2ul 0x7473uL
    else ret input (false)) in
  let! ready = (fun () -> if implements then interface_bases input { inherited with offset = plus inherited.offset 10ul } 64ul else ret input (inherited)) in
  let! ready = (fun () -> if implements then record_jsx_span input ready 18ul inherited.offset ready.offset else ret input ready) in
  let depth = minus 65ul fuel in
  let ready = if U32.(depth >^ ready.depth) then { ready with depth } else ready in
  let! start = (fun () -> consume input ready 123uy) in
  let! start = (fun () -> if input.private_possible then record_private input start (start_range ready.offset) PrivateScope
    else ret input start) in
  let! closed = (fun () -> class_members input start fuel input.size derived false kind no_overload) in
  let! closed = (fun () -> if input.capture_types && closed.count <> start.count then
    record_jsx_span input closed 24ul ready.offset closed.offset else ret input closed) in
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
          let! key = (fun () -> if G.decimal_digit byte || byte = 46uy then number_end input st.offset
            else if byte = 91uy then computed_property_name input st
            else property_name input st) in
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
  : Tot (stt (bool & parser_state) (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 18; 0]) =
  let! byte = (fun () -> peek input state.offset) in
  let! constant = (fun () -> if byte = 99uy then keyword input state.offset 5ul 0x636f6e7374uL else ret input false) in
  let! lexical = (fun () -> if byte = 108uy then keyword input state.offset 3ul 0x6c6574uL else ret input false) in
  let! var = (fun () -> if local_var && byte = 118uy then keyword input state.offset 3ul 0x766172uL else ret input false) in
  let width = if constant then 5ul else if lexical || var then 3ul else 0ul in
  if state.status <> 0ul then ret input (false, state)
  else
    let! start = (fun () -> if width = 0ul then ret input state else skip input { state with offset = plus state.offset width }) in
    let mark = state.local_names in
    let! var_pattern = (fun () -> if var then
      let! first = (fun () -> peek input start.offset) in ret input (first = 91uy || first = 123uy)
      else ret input false) in
    let! bound = (fun () -> if constant || lexical || var_pattern then pattern_binding input start binding_region_width mark mark fuel
      else if width = 0ul && byte = 91uy then
        let! target = (fun () -> atom input { start with in_allowed = false } fuel) in
        let st = { target.parser with in_allowed = start.in_allowed } in
        ret input { state = if target.target = ArrayTarget then st else failed st 1ul; used = mark }
      else let! target = (fun () -> name input start.offset false true) in ret input { state = from_cursor start target; used = mark }) in
    let! next_token = (fun () -> skip input bound.state) in
    let! of_token = (fun () -> keyword input next_token.offset 2ul 0x6f66uL) in
    let! in_token = (fun () -> keyword input next_token.offset 2ul 0x696euL) in
    let! async_target = (fun () -> if allow_in && of_token && width = 0ul && byte = 97uy then
      keyword input start.offset 5ul 0x6173796e63uL else ret input false) in
    if next_token.status <> 0ul || async_target || not (of_token || (allow_in && in_token)) then ret input (false, failed state 1ul)
    else
      let value = { next_token with offset = plus next_token.offset 2ul } in
      let! tracked = (fun () -> if var_pattern then
        record_local_pattern_kind input (record_binding_mode value VarLocals) mark bound.used LocalVarName
      else if var then record_local input (record_binding_mode value VarLocals) { G.first = start.offset; G.last = bound.state.offset } LocalVarName
      else if local_var && (constant || lexical) then
        record_local_pattern input (record_binding_mode value LexicalLocals) mark bound.used
      else ret input value) in
      ret input (true, tracked)

and parameter_prefix (input:tape) (state:parser_state) (floor used:names_used) (fuel:U32.t)
  : Tot (stt parameter_list (heap input) (fun _ -> heap input)) (decreases %[U32.v fuel; 18; 0]) =
  let! first = (fun () -> peek input state.offset) in
  let! bound = (fun () -> pattern_binding input { state with await_allowed = false; yield_allowed = false } binding_region_width floor used fuel) in
  let! tail = (fun () -> skip input { bound.state with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed }) in
  let! typed = (fun () -> (let! anf_value_1 = (fun () -> same input tail.offset 63uy) in if anf_value_1 then
      let! mark = (fun () -> consume input tail 63uy) in
      let! mark = (fun () -> record_jsx_span input mark 12ul tail.offset mark.offset) in
      let! colon = (fun () -> skip input mark) in
      let! delimiter = (fun () -> peek input colon.offset) in
      if G.identifier_start first && (delimiter = 44uy || delimiter = 41uy) then ret input colon
      else
        let! typed = (fun () -> (let! anf_value_3 = (fun () -> consume input colon 58uy) in annotation_type input anf_value_3 16ul 64ul)) in
        record_jsx_span input typed 7ul colon.offset typed.offset
    else capture_annotation input tail false)) in
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
  else
    // One attribute: a name or a string as its key and a string as its value, as engines require.
    let! key_first = (fun () -> peek input #frame key.offset) in
    let! key_end = (fun () -> if key_first = 34uy || key_first = 39uy then string_end input #frame (next key.offset) key_first input.size false
      else name input #frame key.offset false false) in
    let! colon = (fun () -> skip input #frame (from_cursor key key_end)) in
    let! value = (fun () -> (let! anf_value_5 = (fun () -> (consume input #frame colon 58uy)) in skip input #frame anf_value_5)) in
    let! delimiter = (fun () -> peek input #frame value.offset) in
    if delimiter <> 34uy && delimiter <> 39uy then read_ret input #frame (failed value 1ul)
    else
      let! literal = (fun () -> string_end input #frame (next value.offset) delimiter input.size false) in
      let! ending = (fun () -> skip input #frame (from_cursor value literal)) in
      let! ending = (fun () -> (let! anf_value_6 = (fun () -> same input #frame ending.offset 44uy) in if anf_value_6 then (let! anf_value_7 = (fun () -> (consume input #frame ending 44uy)) in skip input #frame anf_value_7) else read_ret input #frame (ending))) in
      consume input #frame ending 125uy)

// `attributes_on_next_line`: an import may carry its with clause on the following line; behind a re-export
// TypeScript reads that line as a statement of its own.
let import_source (input:tape) (#frame:slprop) (state:parser_state) (attributes_on_next_line:bool) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st = (fun () -> skip input #frame state) in
  let! delimiter = (fun () -> peek input #frame st.offset) in
  if st.status <> 0ul || (delimiter <> 34uy && delimiter <> 39uy) then read_ret input #frame (failed st 1ul)
  else
    let! literal = (fun () -> (let! anf_value_1 = (fun () -> (string_end input #frame (next st.offset) delimiter input.size false)) in read_ret input #frame (from_cursor st anf_value_1))) in
    let! gap = (fun () -> trivia input #frame literal.offset) in
    let tail = from_cursor literal gap in
    let! has_attributes = (fun () -> if tail.status = 0ul && (attributes_on_next_line || not gap.newline) then keyword input #frame tail.offset 4ul 0x77697468uL else read_ret input #frame (false)) in
    let! ending = (fun () -> if has_attributes then static_import_attributes input #frame tail else read_ret input #frame (literal)) in
    statement_end input #frame ending ending.offset false

let rec import_members (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t) (allow_type:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input ({ state = st; used })
  else (let! anf_value_1 = (fun () -> same input st.offset 125uy) in if anf_value_1 then (let! anf_value_2 = (fun () -> consume input st 125uy) in ret input ({ state = anf_value_2; used }))
  else
    let start = st.offset in
    let! st =
      (fun () -> let! modifier = (fun () -> if allow_type then keyword input st.offset 4ul 0x74797065uL else ret input (false)) in
      if modifier then
        let! after = (fun () -> skip input { st with offset = plus st.offset 4ul }) in
        let! first = (fun () -> peek input after.offset) in
        let! as_ = (fun () -> keyword input after.offset 2ul 0x6173uL) in
        ret input (if G.identifier_start first && not as_ then after else st)
      else ret input (st)) in
    let type_only = st.offset <> start in
    let! first = (fun () -> peek input st.offset) in
    if fuel = 0ul || not (G.identifier_start first) then ret input ({ state = failed st 1ul; used })
    else
      let! imported = (fun () -> scan_class input st.offset G.Identifier) in
      let! tail = (fun () -> skip input { st with offset = imported }) in
      let namespace = if input.capture_types && (type_only || not allow_type) then TypeOnlyImport else BothNames in
      let! local =
        (fun () -> (let! anf_value_3 = (fun () -> keyword input tail.offset 2ul 0x6173uL) in if anf_value_3 then
          let! start = (fun () -> skip input { tail with offset = plus tail.offset 2ul }) in
          bind_in_namespace input start 0ul 0ul used start.offset namespace
        else bind_in_namespace input st 0ul 0ul used st.offset namespace)) in
      let! st = (fun () -> skip input local.state) in
      (let! comma = (fun () -> same input st.offset 44uy) in
      let! end_ = (fun () -> if comma then consume input st 44uy else ret input st) in
      let last = if comma then end_.offset else local.state.offset in
      let! recorded = (fun () -> if type_only then record_jsx_span input end_ 14ul start last else ret input end_) in
      if comma then import_members input recorded local.used (minus fuel 1ul) allow_type
      else (let! closed = (fun () -> consume input recorded 125uy) in ret input ({ state = closed; used = local.used }))))

let import_bindings (input:tape) (state:parser_state) (used:names_used) (allow_type:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! st = (fun () -> skip input state) in
  let! byte = (fun () -> peek input st.offset) in
  if st.status <> 0ul then ret input ({ state = st; used })
  else if byte = 123uy then (let! anf_value_1 = (fun () -> (consume input st 123uy)) in import_members input anf_value_1 used input.size allow_type)
  else if byte = 42uy then
    let! as_ = (fun () -> skip input { st with offset = next st.offset }) in
    (let! anf_value_2 = (fun () -> keyword input as_.offset 2ul 0x6173uL) in if anf_value_2 then
      let! local = (fun () -> skip input { as_ with offset = plus as_.offset 2ul }) in
      let namespace = if input.capture_types && not allow_type then TypeOnlyImport else BothNames in
      bind_in_namespace input local 0ul 0ul used local.offset namespace
    else ret input ({ state = failed st 1ul; used }))
  else ret input ({ state = failed st 1ul; used })

// import x = require("m") and import A = B.C. TypeScript writes const x = require("m") and var A = B.C;
// the emitter replaces the keyword, recorded as kind 40 or 41. The name is a value of the module.
// The entity name of an alias: names joined by dots, none of them a reserved word.
let rec alias_path (input:tape) (state:parser_state) (fuel:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! after = (fun () -> trivia input state.offset) in
  let! dot = (fun () -> if after.ok then same input after.at 46uy else ret input false) in
  if not dot then ret input state
  else if after.newline || fuel = 0ul then ret input (failed state 1ul)
  else
    let! property = (fun () -> skip input { state with offset = next after.at }) in
    let! segment = (fun () -> name input property.offset false false) in
    if property.status <> 0ul || not segment.ok then ret input (failed property 1ul)
    else alias_path input { property with offset = segment.at } (minus fuel 1ul)

let import_equals (input:tape) (state st after_name:parser_state) (used:names_used)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! bound = (fun () -> bind_in_namespace input st 0ul 0ul used st.offset BothNames) in
  let! value = (fun () -> skip input { bound.state with offset = next after_name.offset }) in
  let! required = (fun () -> keyword input value.offset 7ul 0x72657175697265uL) in
  let! opening = (fun () -> if required then skip input { value with offset = plus value.offset 7ul } else ret input value) in
  let! call = (fun () -> if required then same input opening.offset 40uy else ret input false) in
  let! target = (fun () -> if call then
      let! inside = (fun () -> (let! opened = (fun () -> consume input opening 40uy) in skip input opened)) in
      let! delimiter = (fun () -> peek input inside.offset) in
      if delimiter <> 34uy && delimiter <> 39uy then ret input (failed inside 1ul)
      else
        let! literal = (fun () -> string_end input (next inside.offset) delimiter input.size false) in
        let! closing = (fun () -> skip input (from_cursor inside literal)) in
        consume input closing 41uy
    else
      let! first = (fun () -> name input value.offset false false) in
      if not first.ok then ret input (failed value 1ul) else alias_path input { value with offset = first.at } 64ul) in
  // The emitter copies the rest as written, and a const or var declaration would continue into a next line
  // that an import declaration ends before. Only a semicolon, the end of the file or a next line that begins
  // with a word ends it here; in and instanceof are words that would continue, so no word in i but import.
  let! gap = (fun () -> trivia input target.offset) in
  let! semicolon = (fun () -> if gap.ok then same input gap.at 59uy else ret input false) in
  let! imported = (fun () -> keyword input gap.at 6ul 0x696d706f7274uL) in
  let! exported = (fun () -> keyword input gap.at 6ul 0x6578706f7274uL) in
  let! following = (fun () -> peek input gap.at) in
  let ended = if target.status <> 0ul then target
    else if semicolon then { target with offset = next gap.at }
    else if gap.ok && (gap.at = input.size || (gap.newline && (imported || exported || (G.identifier_start following && following <> 105uy)))) then target
    else failed target 1ul in
  let! recorded = (fun () -> record_jsx_span input ended (if call then 40ul else 41ul) state.offset (plus state.offset 6ul)) in
  ret input ({ bound with state = recorded })

let import_declaration (input:tape) (state:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! st = (fun () -> skip input { state with offset = plus state.offset 6ul }) in
  let! byte = (fun () -> peek input st.offset) in
  let! alias_end = (fun () -> if input.capture_types && G.identifier_start byte then name input st.offset false true
    else ret input { at = st.offset; ok = false; newline = false }) in
  let! after_alias = (fun () -> if alias_end.ok then skip input (from_cursor st alias_end) else ret input st) in
  let! equals = (fun () -> if alias_end.ok then same input after_alias.offset 61uy else ret input false) in
  let! doubled = (fun () -> if equals then same input (next after_alias.offset) 61uy else ret input false) in
  if equals && not doubled then import_equals input state st after_alias used
  else if byte = 34uy || byte = 39uy then
    let! after = (fun () -> import_source input st true) in
    let! after = (fun () -> record_jsx_span input after 9ul state.offset after.offset) in
    ret input ({ state = after; used })
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
        else
          let namespace = if input.capture_types then TypeOnlyImport else BothNames in
          bind_in_namespace input after_type 0ul 0ul used after_type.offset namespace
      else
        let! default_ = (fun () -> bind_at input st 0ul used st.offset) in
        let! after = (fun () -> skip input default_.state) in
        (let! anf_value_5 = (fun () -> same input after.offset 44uy) in if anf_value_5 then
          (let! anf_value_6 = (fun () -> (consume input after 44uy)) in import_bindings input anf_value_6 default_.used true)
        else ret input ({ default_ with state = after }))) in
    let! st = (fun () -> skip input members.state) in
    let! result =
      (fun () -> (let! anf_value_7 = (fun () -> keyword input st.offset 4ul 0x66726f6duL) in if anf_value_7 then import_source input { st with offset = plus st.offset 4ul } true
      else ret input (failed st 1ul))) in
    let! recorded = (fun () -> record_jsx_span input result (if type_only then 8ul else 9ul) state.offset result.offset) in
    ret input ({ members with state = recorded })

let ambient_variable_width (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! lexical = (fun () -> local_width input #frame start) in
  if lexical <> 0ul then read_ret input #frame (lexical)
  else (let! anf_value_1 = (fun () -> keyword input #frame start 3ul 0x766172uL) in if anf_value_1 then read_ret input #frame (3ul) else read_ret input #frame (0ul))

let namespace_keyword (input:tape) (#frame:slprop) (at:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> peek input #frame at) in
  if start <> 110uy then read_ret input #frame false
  else
    let! prefix = (fun () -> word input #frame at 8ul 0uL) in
    if prefix = 0x6e616d6573706163uL then keyword input #frame (plus at 8ul) 1ul 0x65uL
    else read_ret input #frame false

// The width of the keyword that opens a namespace: `namespace`, or the older `module` in front of a name.
let namespace_width (input:tape) (#frame:slprop) (at:U32.t)
  : Tot (stt U32.t (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! modern = (fun () -> namespace_keyword input #frame at) in
  if modern then read_ret input #frame 9ul
  else
    let! older = (fun () -> keyword input #frame at 6ul 0x6d6f64756c65uL) in
    if not older then read_ret input #frame 0ul
    else
      let! gap = (fun () -> trivia input #frame (plus at 6ul)) in
      let! first = (fun () -> peek input #frame gap.at) in
      read_ret input #frame (if gap.ok && not gap.newline && G.identifier_start first then 6ul else 0ul)

let ambient_modifier (input:tape) (#frame:slprop) (start:U32.t) : Tot (stt cursor (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame start 7ul 0x6465636c617265uL) in if anf_value_1 then
    let! after = (fun () -> trivia input #frame (plus start 7ul)) in
    let! width = (fun () -> ambient_variable_width input #frame after.at) in
    let! alias = (fun () -> if width = 0ul then type_declaration_width input #frame after.at else read_ret input #frame 0ul) in
    let! declaration = (fun () -> if width = 0ul && alias = 0ul then
      let! byte = (fun () -> peek input #frame after.at) in
      if byte = 99uy then class_keyword input #frame after.at
      else if byte = 101uy then keyword input #frame after.at 4ul 0x656e756duL
      else if byte = 110uy then namespace_keyword input #frame after.at
      else if byte = 109uy then (let! width = (fun () -> namespace_width input #frame after.at) in read_ret input #frame (width = 6ul))
      else if byte = 102uy then keyword input #frame after.at 8ul 0x66756e6374696f6euL
      else
        let! abstract_ = (fun () -> abstract_class_start input #frame after.at) in
        read_ret input #frame abstract_.ok
      else read_ret input #frame false) in
    read_ret input #frame ({ after with ok = after.ok && not after.newline && (width <> 0ul || alias <> 0ul || declaration) })
  else read_ret input #frame ({ at = start; ok = false; newline = false }))

type declaration_head = {
  after_modifiers:parser_state; width:U32.t; async_declaration:bool; ambient_declaration:bool; class_declaration:bool; abstract_class:bool
}

let declaration_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt declaration_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! st =
    (fun () -> (let! anf_value_1 = (fun () -> keyword input #frame state.offset 6ul 0x6578706f7274uL) in if anf_value_1 then skip input #frame { state with offset = plus state.offset 6ul }
    else read_ret input #frame (state))) in
  let! async_ = (fun () -> async_function input #frame st.offset) in
  let st = if async_.ok then { st with offset = async_.at } else st in
  let! ambient = (fun () -> ambient_modifier input #frame st.offset) in
  let st = if ambient.ok then { st with offset = ambient.at } else st in
  let! abstract_ = (fun () -> abstract_class_start input #frame st.offset) in
  let st = if abstract_.ok then { st with offset = abstract_.at } else st in
  let! class_ = (fun () -> if abstract_.ok then read_ret input #frame true else class_keyword input #frame st.offset) in
  let! width =
    (fun () -> if class_ then read_ret input #frame (5ul)
    else (let! anf_value_2 = (fun () -> keyword input #frame st.offset 8ul 0x66756e6374696f6euL) in if anf_value_2 then read_ret input #frame (8ul)
    else
      let! declared = (fun () -> type_declaration_width input #frame st.offset) in
      if declared <> 0ul then read_ret input #frame (declared)
      else ambient_variable_width input #frame st.offset)) in
  read_ret input #frame ({ after_modifiers = st; width; async_declaration = async_.ok; ambient_declaration = ambient.ok;
    class_declaration = class_; abstract_class = abstract_.ok })

let module_function (input:tape) (state:parser_state) (used:names_used) (declaration_start:U32.t) (async_ ambient:bool)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! head = (fun () -> read_generator_head input state) in
  let state = if ambient && head.generator then failed head.after_star 1ul else head.after_star in
  let! named = (fun () -> (let! anf_value_1 = (fun () -> (name input state.offset false true)) in ret input (from_cursor state anf_value_1))) in
  let! function_ = (fun () -> function_form input named 64ul async_ NoSuper (not head.generator) OrdinaryParameters head.generator) in
  let after = function_.after_function in
  if after.status <> 0ul then ret input ({ state = after; used })
  // A declared function has no body.
  else if ambient && not function_.signature_only then ret input ({ state = failed after 1ul; used })
  else
    let namespace = if function_.signature_only then FunctionSignature else FunctionImplementation in
    let! binding = (fun () -> bind_in_namespace input state 0ul 0ul used state.offset namespace) in
    let! result = (fun () -> if binding.state.status <> 0ul then ret input (failed after 1ul)
      else if input.capture_types && function_.signature_only then
        // The validated signature has no runtime operands. Replace its private child spans.
        record_jsx_span input { after with count = state.count } 8ul declaration_start after.offset
      else ret input after) in
    ret input ({ binding with state = result })

#push-options "--z3rlimit 20"
// A module-level var may be declared again by another var. Its entry among the module's names carries owner 1.
let rec var_seen (input:tape) (used:names_used) (pos len:U32.t)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U32.v used) =
  if used = 0ul then ret input false
  else
    let previous = U32.sub used 1ul in
    let base:names_base = 0ul in
    let! saved = (fun () -> get_binding input (U32.add base previous)) in
    let! equal = (fun () -> if saved.owner = 1uy && len = minus saved.span.G.last saved.span.G.first then
      same_bytes input pos saved.span.G.first len else ret input false) in
    if equal then ret input true else var_seen input previous pos len

let module_var_name (input:tape) (st:parser_state) (used:names_used)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! end_name = (fun () -> name input st.offset false true) in
  let length = minus end_name.at st.offset in
  let! repeated = (fun () -> if end_name.ok && U32.(length <=^ 256ul) then var_seen input used st.offset length else ret input false) in
  if repeated then
    let named = from_cursor st end_name in
    let! first = (fun () -> peek input st.offset) in
    let! recorded = (fun () -> if input.capture_types then record_contextual_reference input named st.offset first else ret input named) in
    ret input ({ state = recorded; used })
  else
    let! bound = (fun () -> bind_pattern_name input st 0ul 0ul used st.offset) in
    if bound.state.status <> 0ul || used = binding_region_width || bound.used = used then ret input bound
    else
      let! _ = (fun () -> set_binding input (U32.add 0ul used) { span = { G.first = st.offset; G.last = end_name.at }; namespace = ValueName; owner = 1uy }) in
      ret input bound

let rec module_lexical_list (input:tape) (state:parser_state) (used:names_used) (constant names_only hoisted:bool) (remaining angled:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! start = (fun () -> skip input state) in
  if start.status <> 0ul || remaining = 0ul then ret input ({ state = failed start 1ul; used })
  else
    let! first = (fun () -> peek input start.offset) in
    let! decl = (fun () -> if names_only then bind_pattern_name input start 0ul 0ul used start.offset
      else if hoisted && G.identifier_start first then module_var_name input start used
      else pattern_binding input start 0ul 0ul used 64ul) in
    let! value = (fun () -> declarator_value input decl.state 64ul (not constant && G.identifier_start first)) in
    let! tail = (fun () -> skip input value.parser) in
    let! comma = (fun () -> same input tail.offset 44uy) in
    if tail.status <> 0ul then ret input ({ decl with state = tail })
    else if not comma then
      (let! anf_value_1 = (fun () -> (let! ended = (fun () -> statement_end input value.parser value.range.G.last false) in declarators_end input ended angled)) in
        ret input ({ decl with state = anf_value_1 }))
    else
      let! angled = (fun () -> if value.open_angle && angled = 0ul then
          first_less_from input start.offset tail.offset start.offset (minus tail.offset start.offset)
        else ret input angled) in
      (let! anf_value_2 = (fun () -> (consume input tail 44uy)) in module_lexical_list input anf_value_2 decl.used constant names_only hoisted (minus remaining 1ul) angled)

// The declarators of `declare const a: T, b;`: names with optional annotations and no initializers.
let rec ambient_declarators (input:tape) (decl:named_state) (remaining:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input decl.state) in
  let! colon = (fun () -> same input st.offset 58uy) in
  let! annotation = (fun () -> if colon then
      (let! opened = (fun () -> consume input st 58uy) in annotation_type input opened 16ul 64ul)
    else ret input decl.state) in
  let! tail = (fun () -> skip input annotation) in
  let! comma = (fun () -> same input tail.offset 44uy) in
  if tail.status <> 0ul || not comma then ret input ({ decl with state = annotation })
  else if remaining = 0ul then ret input ({ decl with state = failed tail 3ul })
  else
    let! following = (fun () -> skip input { tail with offset = next tail.offset }) in
    let! bound = (fun () -> bind_in_namespace input following 0ul 0ul decl.used following.offset AmbientValueName) in
    ambient_declarators input bound (minus remaining 1ul)

let rec enum_members (input:tape) (state:parser_state) (remaining:U32.t) (ambient:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input state) in
  if st.status <> 0ul then ret input (st)
  else (let! anf_value_1 = (fun () -> same input st.offset 125uy) in if anf_value_1 then consume input st 125uy
  else if remaining = 0ul then ret input (failed st 3ul)
  else
    let! key = (fun () -> property_name input st) in
    let! tail = (fun () -> skip input (from_cursor st key)) in
    let! value =
      (fun () -> let! initializer = (fun () -> same input tail.offset 61uy) in
        if not initializer then ret input (empty_range tail)
        else
          let! start = (fun () -> consume input tail 61uy) in
          if not ambient then comparison input start 64ul
          else
            let! first = (fun () -> skip input start) in
            let! negative = (fun () -> same input first.offset 45uy) in
            let at = if negative then next first.offset else first.offset in
            let! number = (fun () -> number_end input at) in
            ret input (empty_range (from_cursor first number))) in
    let! tail = (fun () -> skip input value.parser) in
    if tail.status <> 0ul then ret input (tail)
    else (let! anf_value_4 = (fun () -> same input tail.offset 44uy) in if anf_value_4 then
      if value.open_angle then ret input (failed tail 1ul)
      else (let! anf_value_5 = (fun () -> (consume input tail 44uy)) in enum_members input anf_value_5 (minus remaining 1ul) ambient)
    else consume input tail 125uy))

let enum_declaration (input:tape) (state:parser_state) (used:names_used) (ambient:bool) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! start = (fun () -> skip input { state with offset = plus state.offset 4ul }) in
  let! named = (fun () -> bind_in_namespace input start 0ul 0ul used start.offset (if ambient then AmbientBothNames else BothNames)) in
  let! opening = (fun () -> (let! anf_value_1 = (fun () -> (skip input named.state)) in consume input anf_value_1 123uy)) in
  (let! anf_value_2 = (fun () -> enum_members input opening input.size ambient) in ret input ({ named with state = anf_value_2 }))

let global_augmentation_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame state.offset 7ul 0x6465636c617265uL) in if anf_value_1 then
    let! gap = (fun () -> trivia input #frame (plus state.offset 7ul)) in
    let global = if gap.newline then failed state 1ul else from_cursor state gap in
    (let! anf_value_2 = (fun () -> keyword input #frame global.offset 6ul 0x676c6f62616cuL) in if global.status = 0ul && anf_value_2 then
      (let! anf_value_3 = (fun () -> (skip input #frame { global with offset = plus global.offset 6ul })) in consume input #frame anf_value_3 123uy)
    else read_ret input #frame (failed state 1ul))
  else read_ret input #frame (failed state 1ul))

let ambient_module_start (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  (let! anf_value_1 = (fun () -> keyword input #frame state.offset 7ul 0x6465636c617265uL) in if anf_value_1 then
    let! gap = (fun () -> trivia input #frame (plus state.offset 7ul)) in
    let module_ = if gap.newline then failed state 1ul else from_cursor state gap in
    (let! anf_value_2 = (fun () -> keyword input #frame module_.offset 6ul 0x6d6f64756c65uL) in if module_.status = 0ul && anf_value_2 then
      let! name_gap = (fun () -> trivia input #frame (plus module_.offset 6ul)) in
      let quoted = if name_gap.newline then failed state 1ul else from_cursor module_ name_gap in
      let! delimiter = (fun () -> peek input #frame quoted.offset) in
      if quoted.status = 0ul && (delimiter = 34uy || delimiter = 39uy) then
        let! key = (fun () -> string_end input #frame (next quoted.offset) delimiter input.size false) in
        (let! anf_value_3 = (fun () -> (skip input #frame (from_cursor quoted key))) in consume input #frame anf_value_3 123uy)
      else read_ret input #frame (failed state 1ul)
    else read_ret input #frame (failed state 1ul))
  else read_ret input #frame (failed state 1ul))

type namespace_head = { body_start:parser_state; name_start:U32.t }

let named_namespace_start (input:tape) (#frame:slprop) (state:parser_state)
  : Tot (stt namespace_head (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! width = (fun () -> namespace_width input #frame state.offset) in
  if width = 0ul then read_ret input #frame { body_start = failed state 1ul; name_start = state.offset }
  else
    let! gap = (fun () -> trivia input #frame (plus state.offset width)) in
    let st = from_cursor state gap in
    let! named = (fun () -> name input #frame st.offset false true) in
    let! tail = (fun () -> skip input #frame (from_cursor st named)) in
    let! body = (fun () -> if gap.newline then read_ret input #frame (failed tail 1ul) else consume input #frame tail 123uy) in
    read_ret input #frame { body_start = body; name_start = st.offset }

let ambient_interface (input:tape) (#frame:slprop) (st:parser_state) (allow_exports:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! exported = (fun () -> if allow_exports then keyword input #frame st.offset 6ul 0x6578706f7274uL else read_ret input #frame false) in
  let! member = (fun () -> if exported then skip input #frame { st with offset = plus st.offset 6ul } else read_ret input #frame st) in
  let! width = (fun () -> type_declaration_width input #frame member.offset) in
  if width <> 9ul then read_ret input #frame (failed member 1ul)
  else
    let! start = (fun () -> skip input #frame { member with offset = plus member.offset width }) in
    let! ending = (fun () -> name input #frame start.offset false true) in
    let declared = from_cursor start ending in
    let! valid = (fun () -> admissible_type_binding input #frame start.offset declared.offset) in
    if valid then
      let! tail = (fun () -> skip input #frame declared) in
      interface_tail input #frame tail
    else read_ret input #frame (failed declared 1ul)

let rec ambient_interfaces (input:tape) (#frame:slprop) (state:parser_state) (remaining:U32.t) (allow_exports:bool)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input #frame state) in
  if st.status <> 0ul then read_ret input #frame (st)
  else (let! anf_value_1 = (fun () -> same input #frame st.offset 125uy) in if anf_value_1 then consume input #frame st 125uy
  else if remaining = 0ul then read_ret input #frame (failed st 3ul)
  else
    let! member = (fun () -> ambient_interface input #frame st allow_exports) in
    ambient_interfaces input #frame member (minus remaining 1ul) allow_exports)

let ambient_global_var (input:tape) (#frame:slprop) (st:parser_state) (width:U32.t)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> skip input #frame { st with offset = plus st.offset width }) in
  let! named = (fun () -> name input #frame start.offset false true) in
  let! colon = (fun () -> skip input #frame (from_cursor start named)) in
  let! typed = (fun () -> consume input #frame colon 58uy) in
  let! annotation = (fun () -> annotation_type input #frame typed 16ul 64ul) in
  statement_end input #frame annotation annotation.offset true

let ambient_global_function (input:tape) (#frame:slprop) (st:parser_state)
  : Tot (stt parser_state (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> skip input #frame { st with offset = plus st.offset 8ul }) in
  let! named = (fun () -> name input #frame start.offset false true) in
  let! after = (fun () -> skip input #frame (from_cursor start named)) in
  let! parameters = (fun () -> optional_type_parameters input #frame after false) in
  let! after = (fun () -> skip input #frame parameters) in
  let! head = (fun () -> consume input #frame after 40uy) in
  let! params = (fun () -> signature_parameters input #frame head 15ul 1ul head.offset empty_signature_names) in
  let! colon = (fun () -> skip input #frame params) in
  let! typed = (fun () -> consume input #frame colon 58uy) in
  let! annotation = (fun () -> result_type input #frame typed 16ul) in
  statement_end input #frame annotation annotation.offset true

let rec global_augmentation_members (input:tape) (#frame:slprop) (state:parser_state) (remaining:U32.t) (family:U8.t)
  : Tot (stt (parser_state & U8.t) (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input #frame state) in
  let! closing = (fun () -> same input #frame st.offset 125uy) in
  if st.status <> 0ul || closing then
    let! closed = (fun () -> consume input #frame st 125uy) in
    read_ret input #frame (closed, family)
  else if remaining = 0ul then read_ret input #frame (failed st 3ul, family)
  else
    let! byte = (fun () -> peek input #frame st.offset) in
    let! plain_var = (fun () -> if byte = 118uy then keyword input #frame st.offset 3ul 0x766172uL else read_ret input #frame false) in
    // let and const declare a global as var does.
    let! lexical = (fun () -> if byte = 108uy || byte = 99uy then local_width input #frame st.offset else read_ret input #frame 0ul) in
    let var = plain_var || lexical <> 0ul in
    let! function_ = (fun () -> if byte = 102uy then keyword input #frame st.offset 8ul 0x66756e6374696f6euL else read_ret input #frame false) in
    if (var && family = 2uy) || (function_ && family = 1uy) then read_ret input #frame (failed st 1ul, family)
    else
      let! body = (fun () -> if var then ambient_global_var input #frame st (if plain_var then 3ul else lexical)
        else if function_ then ambient_global_function input #frame st
        else
          let! namespace_ = (fun () -> named_namespace_start input #frame st) in
          if namespace_.body_start.status = 0ul then ambient_interfaces input #frame namespace_.body_start remaining true
          else ambient_interface input #frame st false) in
      let family = if var then 1uy else if function_ then 2uy else family in
      global_augmentation_members input #frame body (minus remaining 1ul) family

let rec ambient_namespace_exports (input:tape) (state:parser_state) (floor used locals:names_used) (remaining:U32.t)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! start = (fun () -> skip input state) in
  let! closed = (fun () -> same input start.offset 125uy) in
  if start.status <> 0ul || remaining = 0ul then ret input { state = failed start 1ul; used }
  else if closed then
    let! tail = (fun () -> consume input start 125uy) in
    ret input { state = tail; used }
  else
    let! key = (fun () -> name input start.offset false true) in
    let! available = (fun () -> if key.ok then name_seen input 0ul 0ul locals start.offset (minus key.at start.offset) BothNames
      else ret input false) in
    if not available then ret input { state = failed start 1ul; used }
    else
      let! named = (fun () -> bind_in_namespace input start binding_region_width floor used start.offset TypeName) in
      let! tail = (fun () -> skip input named.state) in
      let! comma = (fun () -> same input tail.offset 44uy) in
      if comma && tail.status = 0ul then
        ambient_namespace_exports input { tail with offset = next tail.offset } floor named.used locals (minus remaining 1ul)
      else
        let! closed = (fun () -> consume input tail 125uy) in
        ret input { named with state = closed }

let rec type_namespace_members (input:tape) (state:parser_state) (floor used locals:names_used) (depth remaining:U32.t) (ambient:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases %[U32.v depth; U32.v remaining]) =
  let! st = (fun () -> skip input state) in
  let! byte = (fun () -> peek input st.offset) in
  if st.status <> 0ul then ret input st
  else if byte = 125uy then consume input st 125uy
  else if remaining = 0ul then ret input (failed st 1ul)
  else if byte = 59uy then
    // A standalone empty statement instantiates a nonambient namespace.
    if not ambient then ret input (failed st 1ul)
    else
      let! next_member = (fun () -> consume input st 59uy) in
      type_namespace_members input next_member floor used locals depth (minus remaining 1ul) ambient
  else
    let! exported = (fun () -> keyword input st.offset 6ul 0x6578706f7274uL) in
    let! member = (fun () -> if exported then skip input { st with offset = plus st.offset 6ul } else ret input st) in
    let! width = (fun () -> type_declaration_width input member.offset) in
    if width = 0ul then
      let! export_list = (fun () -> if ambient && exported then same input member.offset 123uy else ret input false) in
      if export_list then
        let! opening = (fun () -> consume input member 123uy) in
        let! members = (fun () -> ambient_namespace_exports input opening floor used locals 64ul) in
        let! end_ = (fun () -> statement_end input members.state members.state.offset true) in
        type_namespace_members input end_ floor members.used locals depth (minus remaining 1ul) ambient
      else if not exported || depth = 0ul || byte <> 101uy then ret input (failed member 1ul)
      else
        let! namespace_ = (fun () -> named_namespace_start input member) in
        if namespace_.body_start.status <> 0ul then ret input (failed member 1ul)
        else
          let! named = (fun () -> bind_in_namespace input member binding_region_width floor used namespace_.name_start TypeNamespace) in
          if named.state.status <> 0ul then ret input named.state
          else
            let! body = (fun () -> type_namespace_members input namespace_.body_start named.used named.used locals (minus depth 1ul) remaining ambient) in
            type_namespace_members input body floor named.used locals depth (minus remaining 1ul) ambient
    else
      let! start = (fun () -> skip input { member with offset = plus member.offset width }) in
      let! named = (fun () -> bind_in_namespace input start binding_region_width floor used start.offset TypeName) in
      let! valid = (fun () -> admissible_type_binding input start.offset named.state.offset) in
      let! body = (fun () -> if not valid then ret input (failed named.state 1ul)
        else if width = 9ul then interface_tail input named.state
        else type_alias_tail input named.state true) in
      type_namespace_members input body floor named.used locals depth (minus remaining 1ul) ambient

// The members of a namespace that exists at run time. TypeScript lowers it to a function that fills an object:
// `export const a = 1` becomes `N.a = 1`, and an exported function or class is followed by `N.f = f`.
// The emitter writes that text from these records:
//   35  `export const ` up to the name, replaced by `N.`
//   36  `export ` in front of a function or a class, removed
//   37  the closing brace of that declaration, followed by `N.f = f;`
// One declarator per exported variable, no exported enum, no nested namespace and no overloads: the rest is
// left to TypeScript. A reference to an exported variable elsewhere in the body would need `N.` in front of
// it, so the emitter declines when the name occurs twice.
let rec runtime_namespace_members (input:tape) (state:parser_state) (floor used:names_used) (remaining:U32.t) (instantiated:bool)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  let! st = (fun () -> skip input { state with local_names = used }) in
  let! closed = (fun () -> same input st.offset 125uy) in
  // A namespace that holds types alone does not exist at run time, and TypeScript writes nothing for it.
  if st.status <> 0ul then ret input st
  else if closed then ret input (if instantiated then st else failed st 1ul)
  else if remaining = 0ul || st.offset = input.size then ret input (failed st 1ul)
  else
    let! first = (fun () -> peek input st.offset) in
    let! exported = (fun () -> if first = 101uy then keyword input st.offset 6ul 0x6578706f7274uL else ret input false) in
    if not exported then
      // A type alias or an interface is erased and does not make the namespace exist.
      let! local_type = (fun () -> type_declaration_width input st.offset) in
      let! statement = (fun () -> scope_statement input st 64ul false NoJump floor used false true) in
      runtime_namespace_members input statement.state floor statement.used (minus remaining 1ul) (instantiated || local_type = 0ul)
    else
      let! after = (fun () -> trivia input (plus st.offset 6ul)) in
      let! lexical = (fun () -> local_width input after.at) in
      let! var_ = (fun () -> keyword input after.at 3ul 0x766172uL) in
      let! function_head = (fun () -> function_start input after.at) in
      let! class_ = (fun () -> class_keyword input after.at) in
      let! abstract_ = (fun () -> abstract_class_start input after.at) in
      let! type_width = (fun () -> type_declaration_width input after.at) in
      let! enumeration = (fun () -> local_enum_start input after.at) in
      if not after.ok then ret input (failed st 1ul)
      else if enumeration.ok then
        // Kind 39: the emitter writes the enum as inside a block and stores it in the namespace object.
        let declared = record_binding_mode st LexicalLocals in
        let! named = (fun () -> skip input { declared with offset = plus enumeration.at 4ul }) in
        let! decl = (fun () -> bind_since input named binding_region_width floor used named.offset) in
        let! tracked = (fun () -> record_local_pattern input decl.state used decl.used) in
        let! opening = (fun () -> (let! body = (fun () -> skip input tracked) in consume input body 123uy)) in
        let! closed = (fun () -> enum_body_tokens input opening input.size) in
        let! recorded = (fun () -> record_compiler_span input closed 39ul { G.first = st.offset; G.last = closed.offset }
          { G.first = after.at; G.last = closed.offset }) in
        runtime_namespace_members input { recorded with local_names = decl.used } floor decl.used (minus remaining 1ul) true
      else if lexical <> 0ul || var_ then
        let width = if var_ then 3ul else lexical in
        let! named = (fun () -> skip input { st with offset = plus after.at width }) in
        let! name_end = (fun () -> name input named.offset false true) in
        let! recorded = (fun () -> record_compiler_span input named 35ul { G.first = st.offset; G.last = named.offset }
          { G.first = named.offset; G.last = name_end.at }) in
        let declared = record_binding_mode recorded LexicalLocals in
        let! decl = (fun () -> if name_end.ok then local_declarators input declared (lexical = 5ul) true floor used 64ul 1ul 0ul
          else ret input ({ state = failed named 1ul; used })) in
        runtime_namespace_members input decl.state floor decl.used (minus remaining 1ul) true
      else if function_head.ok || class_ || abstract_.ok then
        let! recorded = (fun () -> record_jsx_span input st 36ul st.offset after.at) in
        let! statement = (fun () -> scope_statement input { recorded with offset = after.at } 64ul false NoJump floor used false true) in
        let ended = statement.state in
        let! tail = (fun () -> if ended.status = 0ul && U32.gt ended.offset after.at then
            record_compiler_span input ended 37ul { G.first = minus ended.offset 1ul; G.last = ended.offset }
              { G.first = after.at; G.last = ended.offset }
          else ret input (failed ended 1ul)) in
        runtime_namespace_members input tail floor statement.used (minus remaining 1ul) true
      else if type_width = 4ul || type_width = 9ul then
        let! declared = (fun () -> local_type_declaration input { st with offset = after.at } type_width floor used) in
        let! recorded = (fun () -> record_jsx_span input declared.state 19ul st.offset declared.state.offset) in
        runtime_namespace_members input recorded floor declared.used (minus remaining 1ul) instantiated
      else ret input (failed st 1ul)

// Kind 34 covers the head of the namespace through its opening brace, kind 38 its closing brace.
let runtime_namespace (input:tape) (state:parser_state) (declaration_start name_start:U32.t) (body_start:parser_state)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! name_end = (fun () -> name input name_start false true) in
  let name_span = { G.first = name_start; G.last = name_end.at } in
  let! recorded = (fun () -> record_compiler_span input body_start 34ul { G.first = declaration_start; G.last = body_start.offset } name_span) in
  let floor = recorded.local_names in
  let inner = enter_function_locals { recorded with await_allowed = false; yield_allowed = false; in_allowed = true;
    super_context = FunctionBody } in
  let! body = (fun () -> runtime_namespace_members input inner floor floor input.size false) in
  let! closed = (fun () -> consume input { body with local_names = recorded.local_names } 125uy) in
  let! finished = (fun () -> finish_local_scope input closed recorded.local_log_used) in
  let! tail = (fun () -> if finished.status = 0ul && name_end.ok then
      record_compiler_span input finished 38ul { G.first = minus finished.offset 1ul; G.last = finished.offset } name_span
    else ret input (failed finished 1ul)) in
  ret input (leave_function_locals { tail with await_allowed = state.await_allowed; yield_allowed = state.yield_allowed;
    in_allowed = state.in_allowed; super_context = state.super_context } recorded)

let module_declaration (input:tape) (state:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! head = (fun () -> declaration_start input state) in
  let! st = (fun () -> if input.capture_types && head.abstract_class && not head.ambient_declaration then
    let! exported = (fun () -> keyword input state.offset 6ul 0x6578706f7274uL) in
    let! modifier = (fun () -> if exported then skip input { state with offset = plus state.offset 6ul } else ret input state) in
    record_jsx_span input head.after_modifiers 15ul modifier.offset (plus modifier.offset 8ul)
    else ret input head.after_modifiers) in
  let width = head.width in
  let! enumeration = (fun () -> if width = 0ul then
    keyword input st.offset 4ul 0x656e756duL else ret input false) in
  if enumeration then
    let! declared = (fun () -> enum_declaration input st used head.ambient_declaration) in
    let! recorded = (fun () -> record_jsx_span input declared.state (if head.ambient_declaration then 8ul else 13ul)
      state.offset declared.state.offset) in
    ret input { declared with state = recorded }
  else if width = 0ul then
    let! namespace_ = (fun () -> if strict_locals st then named_namespace_start input st
      else ret input { body_start = failed st 1ul; name_start = st.offset }) in
    if namespace_.body_start.status <> 0ul then ret input { state = failed st 1ul; used }
    else
      let! named = (fun () -> bind_in_namespace input st 0ul 0ul used namespace_.name_start TypeNamespace) in
      if named.state.status <> 0ul then ret input named
      else
        let! body = (fun () -> type_namespace_members input namespace_.body_start 0ul 0ul used 8ul input.size head.ambient_declaration) in
        if body.status = 0ul || not input.capture_types || head.ambient_declaration then
          let! recorded = (fun () -> record_jsx_span input body 8ul state.offset body.offset) in
          ret input { named with state = recorded }
        else
          // Not a namespace of types alone. Its name is a value: it conflicts with every other value and
          // shares the name with a type alias or an interface.
          let! value = (fun () -> bind_in_namespace input st 0ul 0ul used namespace_.name_start ValueName) in
          if value.state.status <> 0ul then ret input value
          else
            let! lowered = (fun () -> runtime_namespace input st state.offset namespace_.name_start namespace_.body_start) in
            ret input { value with state = lowered }
  else
    let! start = (fun () -> skip input { st with offset = plus st.offset width }) in
    if width = 8ul then module_function input start used state.offset head.async_declaration head.ambient_declaration
    else if (width = 3ul || width = 5ul) && not head.ambient_declaration && not head.class_declaration then
      let! enumeration = (fun () -> if width = 5ul then keyword input start.offset 4ul 0x656e756duL else ret input (false)) in
      if enumeration then
        let! declared = (fun () -> enum_declaration input start used false) in
        let! recorded = (fun () -> record_jsx_span input declared.state 13ul state.offset declared.state.offset) in
        ret input { declared with state = recorded }
      else
        let! hoisted = (fun () -> if width = 3ul then keyword input st.offset 3ul 0x766172uL else ret input false) in
        module_lexical_list input start used (width = 5ul) false hoisted input.size 0ul
    else if (width = 3ul || width = 5ul) && head.ambient_declaration && not head.class_declaration then
      let! first = (fun () -> bind_in_namespace input start 0ul 0ul used start.offset AmbientValueName) in
      let! all = (fun () -> ambient_declarators input first 64ul) in
      let! ended = (fun () -> statement_end input all.state all.state.offset false) in
      let! recorded = (fun () -> if input.capture_types then record_jsx_span input { ended with count = state.count } 8ul state.offset ended.offset
        else ret input ended) in
      ret input ({ all with state = { recorded with await_allowed = state.await_allowed } })
    else
      let type_only = width = 4ul || width = 9ul in
      let! decl =
        (fun () -> if head.class_declaration then
          bind_in_namespace input start 0ul 0ul used start.offset (if head.ambient_declaration then AmbientClassName else ClassName)
        else
          let! namespace = (fun () -> if width <> 9ul then
              ret input (if type_only then TypeName else if head.ambient_declaration then AmbientValueName else ValueName)
            else
              let! exported = (fun () -> if head.ambient_declaration then ret input false
                else keyword input state.offset 6ul 0x6578706f7274uL) in
              if not exported then ret input InterfaceName
              else
                let! named = (fun () -> name input start.offset false true) in
                let! tail = (fun () -> trivia input named.at) in
                let! plain = (fun () -> same input tail.at 123uy) in
                ret input (if named.ok && tail.ok && plain then ExportedInterfaceName else InterfaceName)) in
          bind_in_namespace input start 0ul 0ul used start.offset namespace) in
      let! st = (fun () -> skip input decl.state) in
      let! result =
        (fun () -> if head.class_declaration then
          let kind = if head.ambient_declaration then AmbientClass else if head.abstract_class then AbstractClass else OrdinaryClass in
          class_tail input st 64ul kind
        else if type_only then
          let! valid = (fun () -> admissible_type_binding input start.offset decl.state.offset) in
          if not valid then ret input (failed st 1ul)
          else if width = 9ul then interface_tail input st
          else type_alias_tail input st false
        else
          let! annotation = (fun () -> (let! anf_value_1 = (fun () -> (consume input st 58uy)) in annotation_type input anf_value_1 16ul 64ul)) in
          statement_end input annotation annotation.offset false) in
      let! result =
        (fun () -> if input.capture_types && head.ambient_declaration then
          record_jsx_span input { result with count = state.count } 8ul state.offset result.offset
        else if type_only then record_jsx_span input result 8ul state.offset result.offset
        else ret input result) in
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
    let! named = (fun () -> if binding.namespace = TypeName || is_interface_binding binding.namespace || binding.namespace = FunctionSignature ||
        binding.namespace = TypeNamespace then ret input ({ state; used })
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
  let! source = (fun () -> if from_ then import_source input { tail with offset = plus tail.offset 4ul } false
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

let rec reexport_members (input:tape) (state:parser_state) (used locals:names_used) (remaining:U32.t)
  (locals_known reserve_names type_statement:bool)
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
        let namespace = if input.capture_types && not type_statement && source.offset = st.offset then RuntimeExport else BothNames in
        name_seen input 0ul 0ul locals source.offset (minus source_end.offset source.offset) namespace
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
    let! named = (fun () -> if reserve_names then reserve_export input last used start stop else ret input { state = last; used }) in
    let! tail = (fun () -> skip input named.state) in
    let! comma = (fun () -> same input tail.offset 44uy) in
    let! ending = (fun () -> if comma then consume input tail 44uy else ret input tail) in
    let! recorded =
      (fun () -> if source.offset = st.offset || not reserve_names || not input.capture_types then ret input ending
      else if type_statement then ret input (failed ending 1ul)
      else
        let last = if comma then ending.offset else named.state.offset in
        record_jsx_span input ending 14ul st.offset last) in
    if comma then reexport_members input recorded named.used locals (minus remaining 1ul) locals_known reserve_names type_statement
    else
      let! closed = (fun () -> consume input recorded 125uy) in
      ret input ({ named = { named with state = closed }; locals_known }))

type pending_exports = n:U32.t{U32.v n <= U32.v deferred_export_limit}

let deferred_export_slot (index:U32.t{U32.v index < U32.v deferred_export_limit})
  : at:U32.t{U32.v at < U32.v binding_capacity} =
  U32.add deferred_export_base index

let named_reexport (input:tape) (state:parser_state) (used locals:names_used) (pending:pending_exports) (type_statement:bool)
  : Tot (stt (named_state & pending_exports) (heap input) (fun _ -> heap input)) =
  let! start = (fun () -> consume input state 123uy) in
  let! resolved = (fun () -> reexport_members input start used locals binding_region_width true true type_statement) in
  let named = resolved.named in
  let! tail = (fun () -> skip input named.state) in
  let! from = (fun () -> keyword input tail.offset 4ul 0x66726f6duL) in
  if from then
    let! source = (fun () -> import_source input { tail with offset = plus tail.offset 4ul } false) in
    ret input ({ named with state = source }, pending)
  else
    let! complete = (fun () -> statement_end input named.state named.state.offset false) in
    if complete.status <> 0ul || resolved.locals_known then ret input ({ named with state = complete }, pending)
    else if pending = deferred_export_limit then ret input ({ named with state = failed complete 1ul }, pending)
    else
      let span = { G.first = start.offset; G.last = named.state.offset } in
      let namespace = if type_statement then TypeName else BothNames in
      let! _ = (fun () -> set_binding input (deferred_export_slot pending) { span; namespace; owner = 0uy }) in
      let more:pending_exports = U32.add pending 1ul in
      ret input ({ named with state = complete }, more)

let unbound_runtime_export_status = 7ul

let rec check_local_exports (input:tape) (state:parser_state) (locals:names_used) (pending:pending_exports)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v pending) =
  if pending = 0ul then ret input state
  else
    let index = U32.sub pending 1ul in
    let! saved = (fun () -> get_binding input (deferred_export_slot index)) in
    let! checked = (fun () -> reexport_members input { state with offset = saved.span.G.first } 0ul locals binding_region_width true false (saved.namespace = TypeName)) in
    if checked.named.state.status = 0ul && checked.named.state.offset = saved.span.G.last then
      if checked.locals_known then check_local_exports input state locals index
      else ret input (failed state (if input.capture_jsx then unbound_runtime_export_status else 1ul))
    else ret input (failed state 1ul)

type export_prefix = { after_export:parser_state; export_kind:U32.t; direct:bool; type_only:bool }

let module_export (input:tape) (#frame:slprop) (state:parser_state) : Tot (stt export_prefix (input_ready input ** frame) (fun _ -> input_ready input ** frame)) =
  let! start = (fun () -> peek input #frame state.offset) in
  let! exported = (fun () -> if start = 101uy then keyword input #frame state.offset 6ul 0x6578706f7274uL else read_ret input #frame (false)) in
  if not exported then read_ret input #frame ({ after_export = state; export_kind = 0ul; direct = false; type_only = false })
  else
    let! tail = (fun () -> skip input #frame { state with offset = plus state.offset 6ul }) in
    (let! anf_value_1 = (fun () -> keyword input #frame tail.offset 7ul 0x64656661756c74uL) in if anf_value_1 then
      read_ret input #frame ({ after_export = tail; export_kind = 1ul; direct = false; type_only = false })
    else
      let! type_only = (fun () -> keyword input #frame tail.offset 4ul 0x74797065uL) in
      let! start = (fun () -> if type_only then skip input #frame { tail with offset = plus tail.offset 4ul } else read_ret input #frame (tail)) in
      let! byte = (fun () -> peek input #frame start.offset) in
      if byte = 42uy then (let! anf_value_2 = (fun () -> (let! anf_value_3 = (fun () -> (consume input #frame start 42uy)) in skip input #frame anf_value_3)) in read_ret input #frame ({ after_export = anf_value_2; export_kind = 2ul; direct = false; type_only }))
      else if byte = 61uy && not type_only then
        read_ret input #frame ({ after_export = start; export_kind = 4ul; direct = false; type_only = false })
      else read_ret input #frame (if byte = 123uy then { after_export = start; export_kind = 3ul; direct = false; type_only }
      else { after_export = state; export_kind = 0ul; direct = true; type_only = false }))

let rec default_function_body (input:tape) (state:parser_state) (spelling:G.span) (async_:bool) (remaining:U32.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v remaining) =
  if state.status <> 0ul || remaining = 0ul then ret input (failed state 1ul)
  else
    let! st = (fun () -> skip input state) in
    let! prefix = (fun () -> module_export input st) in
    if prefix.export_kind <> 1ul then ret input (failed st 1ul)
    else
      let! declaration = (fun () -> skip input { prefix.after_export with offset = plus prefix.after_export.offset 7ul }) in
      let! function_ = (fun () -> function_start input declaration.offset) in
      if not function_.ok || (declaration.offset <> function_.at) <> async_ then ret input (failed declaration 1ul)
      else
        let! start = (fun () -> skip input { declaration with offset = plus function_.at 8ul }) in
        let! name_ = (fun () -> name input start.offset false true) in
        let length = minus spelling.G.last spelling.G.first in
        let! matches = (fun () -> if name_.ok && minus name_.at start.offset = length then
          same_bytes input spelling.G.first start.offset length else ret input false) in
        if not matches then ret input (failed start 1ul)
        else
          let! form = (fun () -> function_form input (from_cursor start name_) 64ul async_ NoSuper true OrdinaryParameters false) in
          if form.signature_only then
            let after = form.after_function in
            let! after = (fun () -> record_jsx_span input { after with count = st.count } 21ul st.offset after.offset) in
            default_function_body input after spelling async_ (minus remaining 1ul)
          else ret input form.after_function

let default_declaration (input:tape) (state:parser_state) (declaration_start:U32.t) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! function_head = (fun () -> function_start input state.offset) in
  let! abstract_ = (fun () -> abstract_class_start input state.offset) in
  (let! class_ = (fun () -> if abstract_.ok then ret input true else class_keyword input state.offset) in if class_ then
    let head = if abstract_.ok then abstract_.at else state.offset in
    let! state = (fun () -> if abstract_.ok then record_jsx_span input state 15ul state.offset (plus state.offset 8ul)
      else ret input state) in
    let! start = (fun () -> skip input { state with offset = plus head 5ul }) in
    let! byte = (fun () -> peek input start.offset) in
    let! derives = (fun () -> keyword input start.offset 7ul 0x657874656e6473uL) in
    let! named = (fun () -> if byte = 123uy || byte = 60uy || derives then ret input ({ state = start; used })
      else bind_at input start 0ul used start.offset) in
    let kind = if abstract_.ok then AbstractClass else OrdinaryClass in
    (let! anf_value_2 = (fun () -> class_tail input named.state 64ul kind) in ret input ({ named with state = anf_value_2 }))
  else if function_head.ok then
    let! start = (fun () -> skip input { state with offset = plus function_head.at 8ul }) in
    let! head = (fun () -> read_generator_head input start) in
    let start = head.after_star in
    let! byte = (fun () -> peek input start.offset) in
    let! name = (fun () -> if byte = 40uy || byte = 60uy then ret input ({ state = start; used })
      else bind_in_namespace input start 0ul 0ul used start.offset ValueName) in
    let async_ = state.offset <> function_head.at in
    let overload = byte <> 40uy && byte <> 60uy && not head.generator in
    let! form = (fun () -> function_form input name.state 64ul async_ NoSuper overload OrdinaryParameters head.generator) in
    let! body = (fun () -> if form.signature_only then
      let after = form.after_function in
      let! after = (fun () -> record_jsx_span input { after with count = state.count } 21ul declaration_start after.offset) in
      default_function_body input after { G.first = start.offset; G.last = name.state.offset } async_ input.size
      else ret input form.after_function) in
    ret input ({ name with state = body })
  else
    let! asserted_object =
      (fun () -> let! angle = (fun () -> if not state.jsx_allowed then same input state.offset 60uy else ret input false) in
        if not angle then ret input (failed state 1ul)
        else
          let! start = (fun () -> consume input state 60uy) in
          let! typed = (fun () -> annotation_type input start 16ul 64ul) in
          let! close = (fun () -> skip input typed) in
          let! after = (fun () -> consume input close 62uy) in
          // The angle-bracket assertion stays in the source. Kind 29 withholds it from publication.
          let! after = (fun () -> record_jsx_span input after 29ul state.offset after.offset) in
          let! object_ = (fun () -> skip input after) in
          consume input object_ 123uy) in
    let! completed = (fun () -> if asserted_object.status = 0ul then
        let depth = if asserted_object.depth = 0ul then 1ul else asserted_object.depth in
        let! object_ = (fun () -> object_members input { asserted_object with depth } 63ul input.size false false) in
        let! tail = (fun () -> skip input object_) in
        if tail.offset = input.size then ret input tail else consume input tail 59uy
      else
        let! value = (fun () -> comparison input state 64ul) in
        statement_end input value.parser value.range.G.last false) in
    ret input ({ state = completed; used }))

private let module_plain_declaration (input:tape) (st:parser_state) (used:names_used) : Tot (stt named_state (heap input) (fun _ -> heap input)) =
  let! first = (fun () -> peek input st.offset) in
  let! resource = (fun () -> if st.module_mode && (first = 117uy || first = 97uy && st.await_allowed) then
    resource_declaration_start input st first else ret input (failed st 1ul)) in
  let! ambient_module = (fun () -> if first = 100uy then ambient_module_start input st else ret input (failed st 1ul)) in
  let! declared =
    (fun () -> if first = 101uy then
      let! enumeration = (fun () -> keyword input st.offset 4ul 0x656e756duL) in
      if enumeration then ret input true else keyword input st.offset 6ul 0x6578706f7274uL
    else if first = 102uy then keyword input st.offset 8ul 0x66756e6374696f6euL
    else if first = 97uy then
      let! abstract_ = (fun () -> abstract_class_start input st.offset) in
      if abstract_.ok then ret input true else (let! anf_value_1 = (fun () -> (async_function input st.offset)) in ret input (anf_value_1.ok))
    else if first = 100uy then (let! anf_value_2 = (fun () -> (ambient_modifier input st.offset)) in ret input (anf_value_2.ok))
    else if first = 99uy then
      let! class_ = (fun () -> class_keyword input st.offset) in
      if class_ then ret input (true) else (let! anf_value_3 = (fun () -> local_width input st.offset) in ret input (anf_value_3 <> 0ul))
    else if first = 105uy || first = 116uy then
      let! width = (fun () -> type_declaration_width input st.offset) in ret input (width <> 0ul)
    else if first = 118uy then keyword input st.offset 3ul 0x766172uL
    else if (first = 110uy || first = 109uy) && strict_locals st then
      let! namespace_ = (fun () -> named_namespace_start input st) in
      ret input (namespace_.body_start.status = 0ul)
    else
      let! width = (fun () -> local_width input st.offset) in ret input (width <> 0ul)) in
  if resource.status = 0ul then module_lexical_list input resource used true true false input.size 0ul
  else if ambient_module.status = 0ul then
    // The body of a declared module holds what a declared namespace may hold: types, interfaces and declarations
    // without values. Interfaces alone are tried first, since they may repeat names of the file.
    let! interfaces = (fun () -> ambient_interfaces input ambient_module input.size true) in
    let! body = (fun () -> if interfaces.status = 0ul then ret input interfaces
      else type_namespace_members input ambient_module 0ul used used 8ul input.size true) in
    let! recorded = (fun () -> record_jsx_span input body 8ul st.offset body.offset) in
    ret input ({ state = recorded; used })
  else if declared then module_declaration input st used
  else (let! anf_value_6 = (fun () -> (let! anf_value_7 = (fun () -> (control_statement input st 64ul false NoJump 0ul 0ul false)) in ret input (anf_value_7.state))) in ret input ({ state = anf_value_6; used }))

// Decorators before a class declaration: the words export, default and abstract may stand between them and class.
let decorated_class_start (input:tape) (state:parser_state) : Tot (stt parser_state (heap input) (fun _ -> heap input)) =
  let! st = (fun () -> decorators input state 64ul 16ul) in
  if st.status <> 0ul || st.offset = state.offset then ret input st
  else
    let! exported = (fun () -> keyword input st.offset 6ul 0x6578706f7274uL) in
    let! after_export = (fun () -> if exported then trivia input (plus st.offset 6ul) else ret input { at = st.offset; ok = true; newline = false }) in
    let! default_ = (fun () -> if exported && after_export.ok then keyword input after_export.at 7ul 0x64656661756c74uL else ret input false) in
    let! after_default = (fun () -> if default_ then trivia input (plus after_export.at 7ul) else ret input after_export) in
    let! abstract_ = (fun () -> if after_default.ok then abstract_class_start input after_default.at else ret input { at = st.offset; ok = false; newline = false }) in
    let! class_ = (fun () -> if after_default.ok && not abstract_.ok then class_keyword input after_default.at else ret input false) in
    ret input (if st.module_mode && (abstract_.ok || class_) then st else failed st 1ul)

// A var inside a block, a loop or a loop head at the top level belongs to the module. Such names stay in the
// local log; at the end of the module each one is entered among the module's names, so that an export list
// finds it. One that meets a name the module declared itself is refused, a repeated var is entered once.
let rec hoist_root_vars (input:tape) (state:parser_state) (floor used:names_used) (index:local_log_used)
  : Tot (stt named_state (heap input) (fun _ -> heap input)) (decreases U16.v index) =
  if index = 0us || state.status <> 0ul then ret input ({ state; used })
  else
    let previous = U16.sub index 1us in
    let! entry = (fun () -> get_binding input (local_slot previous)) in
    if entry.namespace <> LocalVarName then hoist_root_vars input state floor used previous
    else
      let length = minus entry.span.G.last entry.span.G.first in
      let! named = (fun () -> name_seen input 0ul 0ul floor entry.span.G.first length BothNames) in
      let! by_var = (fun () -> if named && U32.(length <=^ 256ul) then var_seen input floor entry.span.G.first length else ret input false) in
      let declared = named && not by_var in
      let! repeated = (fun () -> if by_var then ret input true else name_seen input 0ul floor used entry.span.G.first length ValueName) in
      if declared then ret input ({ state = failed state 1ul; used })
      else if repeated then hoist_root_vars input state floor used previous
      else if used = binding_region_width then ret input ({ state = failed state 1ul; used })
      else
        let! _ = (fun () -> set_binding input (U32.add 0ul used) { span = entry.span; namespace = ValueName; owner = 1uy }) in
        hoist_root_vars input state floor (U32.add used 1ul) previous

let rec module_sequence (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t) (exports:names_used) (pending:pending_exports) (family:U8.t)
  : Tot (stt parser_state (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! undecorated = (fun () -> skip input state) in
  let! st = (fun () -> decorated_class_start input undecorated) in
  if st.status <> 0ul then ret input st
  // The first reading keeps no log of local names. A var below the top level needs one, so that reading is given up.
  else if st.offset = input.size && st.module_mode && st.local_log_floor = primary_locals && st.binding_mode = VarLocals then
    ret input (failed st mixed_locals_status)
  else if st.offset = input.size then (let! hoisted = (fun () -> hoist_root_vars input st used used st.local_log_used) in
    check_local_exports input hoisted.state hoisted.used pending)
  else if fuel = 0ul then ret input (failed st 1ul)
  else (let! anf_value_1 = (fun () -> same input st.offset 59uy) in if anf_value_1 then
    (let! anf_value_2 = (fun () -> consume input st 59uy) in module_sequence input anf_value_2 used (minus fuel 1ul) exports pending family)
  else
    let! first = (fun () -> peek input st.offset) in
    let! augmentation = (fun () -> if first = 100uy then global_augmentation_start input st else ret input (failed st 1ul)) in
    if augmentation.status = 0ul then
      let! closed, family = (fun () -> global_augmentation_members input augmentation input.size family) in
      let! recorded = (fun () -> record_jsx_span input closed 8ul st.offset closed.offset) in
      module_sequence input recorded used (minus fuel 1ul) exports pending family
    else
      let! exported = (fun () -> module_export input st) in
      let! decl, exports, pending =
        (fun () -> if not st.module_mode && (exported.direct || exported.export_kind <> 0ul) then
          ret input ({ state = failed st 1ul; used }, exports, pending)
        else if exported.export_kind = 1ul then
          let name = exported.after_export in
          let end_ = plus name.offset 7ul in
          let! reserved = (fun () -> reserve_export input name exports name.offset end_) in
          let! body = (fun () -> skip input { reserved.state with offset = end_ }) in
          (let! anf_value_3 = (fun () -> default_declaration input body st.offset used) in ret input (anf_value_3, reserved.used, pending))
        else if exported.export_kind = 2ul then
          let! reexported = (fun () -> star_reexport input exported.after_export exports) in
          let! recorded = (fun () -> record_jsx_span input reexported.state (if exported.type_only then 8ul else 9ul) st.offset reexported.state.offset) in
          ret input ({ state = recorded; used }, reexported.used, pending)
        else if exported.export_kind = 3ul then
          let! reexported, pending = (fun () -> named_reexport input exported.after_export exports used pending exported.type_only) in
          let! recorded = (fun () -> record_jsx_span input reexported.state (if exported.type_only then 8ul else 9ul) st.offset reexported.state.offset) in
          ret input ({ state = recorded; used }, reexported.used, pending)
        else if exported.export_kind = 4ul then
          let! closed = (fun () -> if exports <> 0ul || pending <> 0ul then ret input (failed st 1ul)
            else
              let! equals = (fun () -> consume input exported.after_export 61uy) in
              // Kind 33 covers `export =`, which the emitter writes as `module.exports =`.
              let! start = (fun () -> if input.capture_types then record_jsx_span input equals 33ul st.offset equals.offset
                else ret input equals) in
              let! value = (fun () -> comparison input start 64ul) in
              let! end_ = (fun () -> statement_end input value.parser value.range.G.last false) in
              let! tail = (fun () -> skip input end_) in
              ret input (if tail.offset = input.size then tail else failed tail 1ul)) in
          ret input ({ state = closed; used }, exports, pending)
        else (let! anf_value_5 = (fun () -> keyword input st.offset 6ul 0x696d706f7274uL) in if anf_value_5 then
          (let! anf_value_6 = (fun () -> import_expression_start input st) in if anf_value_6 then
            (let! anf_value_7 = (fun () -> (let! anf_value_8 = (fun () -> (let! anf_value_9 = (fun () -> (control_statement input st 64ul false NoJump 0ul 0ul false)) in ret input (anf_value_9.state))) in ret input ({ state = anf_value_8; used }))) in ret input (anf_value_7, exports, pending))
          else if st.module_mode then
            (let! anf_value_10 = (fun () -> import_declaration input st used) in ret input (anf_value_10, exports, pending))
          else ret input ({ state = failed st 1ul; used }, exports, pending))
        else
          (let! anf_value_11 = (fun () -> module_plain_declaration input st used) in ret input (anf_value_11, exports, pending)))) in
      let! reserved = (fun () -> if exported.direct then reserve_direct_exports input decl.state exports used decl.used
        else ret input ({ state = decl.state; used = exports })) in
      module_sequence input reserved.state decl.used (minus fuel 1ul) reserved.used pending family)

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

let initial_state (jsx module_mode:bool) (local_log_floor:U16.t) : parser_state = {
  offset = 0ul; count = 0ul; depth = 0ul; status = 0ul; local_names = 0ul;
  await_allowed = module_mode; yield_allowed = false; jsx_allowed = jsx; module_mode; strict_script = false; in_allowed = true; for_initializer = false;
  arrow_defaults_allowed = true; binding_mode = NoLocals; super_context = NoSuper; private_scope = 0uy; private_count = 0uy;
  local_log_floor; local_log_used = 0us
}

// Successful results consume the buffer and expose a bounded candidate count.
type parse_result (input:tape) = r:parser_state{
  (r.status = 0ul ==> r.offset = input.size /\ U32.v r.count <= U32.v input.capacity) /\
  (r.status <> 0ul ==> r.count = 0ul)
}

let parse_attempt (input:tape) (jsx module_mode:bool) (local_log_floor:U16.t)
  : Tot (stt (parse_result input) (heap input) (fun _ -> heap input)) =
  let! initial = (fun () -> (let! anf_value_1 = (fun () -> (let! anf_value_2 = (fun () -> source_start input) in ret input ({ (initial_state jsx module_mode local_log_floor) with offset = anf_value_2 }))) in skip input anf_value_1)) in
  // The compiler publishes a TypeScript script with the strict directive in front, as TypeScript does, so it
  // reads the script as strict code. The extractor keeps the script's own mode.
  let! strict_script = (fun () -> if module_mode then ret input false
    else if input.capture_types then ret input true
    else strict_directive input initial.offset) in
  let initial = { initial with strict_script } in
  let! script_var = (fun () -> if module_mode || initial.status <> 0ul then ret input false
    else keyword input initial.offset 3ul 0x766172uL) in
  let! state : parser_state =
    (fun () -> if script_var then
      // A long script may end its first var declaration by ASI after a large initializer.
      let! expanded = (fun () -> module_sequence input initial 0ul input.size 0ul 0ul 0uy) in
      if (expanded.status = 0ul && expanded.offset = input.size) || expanded.status = mixed_locals_status then ret input expanded
      else
        let! _ = (fun () -> clear_marks input) in
        let! legacy = (fun () -> parse_state input initial module_mode) in
        ret input (if legacy.status <> 1ul && (legacy.status <> 0ul || legacy.offset = input.size) then legacy else expanded)
    else
      let! legacy = (fun () -> parse_state input initial module_mode) in
      // A var below the top level belongs to the file. Only the reading that keeps the file's names can tell
      // whether it meets one of them, so its answer stands.
      let hoisting = module_mode && legacy.status = 0ul && (legacy.binding_mode = VarLocals || legacy.binding_mode = MixedLocals) in
      if legacy.status = 1ul || (legacy.status = 0ul && legacy.offset <> input.size) || hoisting then
        let! _ = (fun () -> clear_marks input) in
        let! expanded = (fun () -> module_sequence input initial 0ul input.size 0ul 0ul 0uy) in
        ret input (if expanded.status = 1ul && not hoisting then legacy else expanded)
      else ret input legacy) in
  let! private_ok = (fun () -> if state.status = 0ul && state.offset = input.size && state.private_count <> 0uy then
    valid_private_log input state.private_count state.private_count else ret input true) in
  ret #(parse_result input) input (if state.status <> 0ul || state.offset <> input.size || not private_ok then
    { (failed state 1ul) with count = 0ul }
  else if input.count_only then { state with count = 0ul }
  else if U32.(state.count >^ input.capacity) then
    { (failed state 4ul) with count = 0ul }
  else state)

// Most inputs use one kind of function-local declaration. Only a mixed
// function needs a second pass with exact declaration spelling checks.
let parse_candidates (input:tape) (jsx module_mode:bool)
  : Tot (stt (parse_result input) (heap input) (fun _ -> heap input)) =
  let! first = (fun () -> parse_attempt input jsx module_mode primary_locals) in
  if first.status <> mixed_locals_status then ret #(parse_result input) input first
  else
    let! _ = (fun () -> clear_marks input) in
    // A module's second reading keeps the log at the top level too, for the vars below it.
    parse_attempt input jsx module_mode (if module_mode then 0us else inactive_locals)

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
  let! conflict = (fun () -> read_lexical_conflict input (initial_state false true primary_locals) 0ul (no_conflict ()) input.size) in
  ret #(checked_conflict input) input (let first = conflict.first_name in
  let second = conflict.repeated_name in
  if U32.(first.G.first <^ first.G.last && first.G.last <=^ second.G.first &&
    second.G.first <^ second.G.last && second.G.last <=^ input.size) then conflict
  else no_conflict ())
