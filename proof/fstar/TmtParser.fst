module TmtParser

open FStar.HyperStack.ST
module B = LowStar.Buffer
module C = LowStar.ConstBuffer
module U8 = FStar.UInt8
module U32 = FStar.UInt32
module U64 = FStar.UInt64
module Cast = FStar.Int.Cast
module G = TmtGrammar
module S = TmtScan

type binding_namespace =
  | TypeName
  | ValueName
  | BothNames
  | FunctionSignature
  | FunctionImplementation

type binding_name = { span:G.span; namespace:binding_namespace }

let binding_region_width : U32.t = 512ul
let export_region_base : U32.t = 1024ul

noeq type tape = {
  source : C.const_buffer U8.t;
  size : n:U32.t { U32.v n == C.length source /\ U32.v n <= 1048576 };
  output : B.buffer G.candidate;
  capacity : n:U32.t { U32.v n == B.length output };
  bindings : b:B.buffer binding_name { B.length b == 1536 }
}

let live (input:tape) h = C.live h input.source /\ B.live h input.output /\ B.live h input.bindings

effect Read (a:Type) (input:tape) =
  Stack a (requires fun h -> C.live h input.source) (ensures fun h0 _ h1 -> h0 == h1)

effect Run (a:Type) (input:tape) =
  Stack a (requires fun h -> live input h) (ensures fun _ _ h -> live input h)

let plus (value:U32.t) (amount:U32.t) : U32.t = U32.add_mod value amount
let minus (value:U32.t) (amount:U32.t) : U32.t = U32.sub_mod value amount

let peek (input:tape) (at:U32.t) : Read U8.t input = S.peek input.source input.size at

let same (input:tape) (at:U32.t) (byte:U8.t) : Read bool input =
  let found = peek input at in
  found = byte

let next (at:U32.t) : U32.t = plus at 1ul

type cursor = { at:U32.t; ok:bool; newline:bool }

let line_break (input:tape) (at:U32.t) : Read bool input =
  let ch = peek input at in
  if ch = 13uy || ch = 10uy then true
  else if ch = 226uy then S.unicode_line_separator input.source input.size at
  else false

let rec line_comment (input:tape) (at:U32.t) (fuel:U32.t)
  : Read cursor input (decreases U32.v fuel) =
  if U32.(at >=^ input.size) then { at; ok = true; newline = false }
  else if fuel = 0ul then { at; ok = false; newline = false }
  else
    let stop = line_break input at in
    if stop then { at; ok = true; newline = false }
    else line_comment input (next at) (minus fuel 1ul)

let rec block_comment (input:tape) (at:U32.t) (newline:bool) (fuel:U32.t)
  : Read cursor input (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ input.size) then { at; ok = false; newline }
  else
    let is_star = same input at 42uy in
    let is_slash = same input (next at) 47uy in
    if is_star && is_slash then { at = plus at 2ul; ok = true; newline }
    else
      let breaks = line_break input at in
      block_comment input (next at) (newline || breaks) (minus fuel 1ul)

let rec trivia_from (input:tape) (at:U32.t) (newline:bool) (fuel:U32.t)
  : Read cursor input (decreases U32.v fuel) =
  if U32.(at >=^ input.size) then { at; ok = true; newline }
  else if fuel = 0ul then { at; ok = false; newline }
  else
    let ch = peek input at in
    if G.whitespace ch then
      trivia_from input (next at) (newline || ch = 13uy || ch = 10uy) (minus fuel 1ul)
    else if ch = 226uy then
      let separator = S.unicode_line_separator input.source input.size at in
      if separator then trivia_from input (plus at 3ul) true (minus fuel 1ul)
      else { at; ok = true; newline }
    else if ch = 47uy then
      let follower = peek input (next at) in
      if follower = 47uy || follower = 42uy then
        let where = plus at 2ul in
        let r = if follower = 47uy then line_comment input where input.size else block_comment input where false input.size in
        if r.ok then trivia_from input r.at (newline || r.newline) (minus fuel 1ul)
        else r
      else { at; ok = true; newline }
    else { at; ok = true; newline }

let trivia (input:tape) (at:U32.t) : Read cursor input =
  trivia_from input at false (plus input.size 1ul)

let scan_class (input:tape) (at:U32.t) (cls:G.byte_class) : Read U32.t input =
  if U32.(at <=^ input.size) then S.scan_class input.source input.size at cls else at

let rec jsx_name_end (input:tape) (at:U32.t) (fuel:U32.t) : Read U32.t input (decreases U32.v fuel) =
  if fuel = 0ul then at
  else
    let finish = scan_class input at G.Identifier in
    let dash = same input finish 45uy in
    if dash then jsx_name_end input (next finish) (minus fuel 1ul) else finish

let rec word (input:tape) (at:U32.t) (fuel:U32.t) (value:U64.t) : Read U64.t input (decreases U32.v fuel) =
  if fuel = 0ul then value
  else
    let byte = peek input at in
    word input (next at) (minus fuel 1ul) (U64.logor (U64.shift_left value 8ul) (Cast.uint8_to_uint64 byte))

let keyword (input:tape) (at:U32.t) (size:U32.t) (expected:U64.t) : Read bool input =
  let value = word input at size 0uL in
  let following = peek input (plus at size) in
  value = expected && not (G.identifier_continue following)

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

let name (input:tape) (at:U32.t) (jsx binding:bool) : Read cursor input =
  let first = peek input at in
  if not (G.identifier_start first) then { at; ok = false; newline = false }
  else if jsx then { at = jsx_name_end input at input.size; ok = true; newline = false }
  else
    let stop = scan_class input at G.Identifier in
    let width = minus stop at in
    if U32.(width >^ 10ul) then { at = stop; ok = true; newline = false }
    else
      let wide = U32.(width >^ 8ul) in
      let head = word input at (if wide then 8ul else width) 0uL in
      let rest = if wide then word input (plus at 8ul) (minus width 8ul) 0uL else 0uL in
      let reserved = if wide then long_reserved head rest else short_reserved head in
      let invalid_binding = binding && (head = 0x6576616cuL || (head = 0x617267756d656e74uL && rest = 0x73uL)) in
      { at = stop; ok = not (reserved || invalid_binding); newline = false }

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
  await_allowed:bool; jsx_allowed:bool; module_mode:bool; in_allowed:bool; for_initializer:bool;
  arrow_defaults_allowed:bool; binding_mode:binding_mode; super_context:super_context
}
type assignment_target =
  | NotAssignable
  | Assignable
  | MemberTarget
  | OptionalChain

type jump_context =
  | NoJump
  | BreakOnly
  | LoopJump

let can_assign (target:assignment_target) : bool = target = Assignable || target = MemberTarget
type parsed = { parser:parser_state; range:G.span; open_angle:bool; outer_or:bool; right_shift:bool; shortcut:U32.t; target:assignment_target }

let failed (state:parser_state) (error:U32.t) : parser_state =
  if state.status = 0ul then { state with status = error } else state

let record_binding_mode (state:parser_state) (kind:binding_mode) : parser_state =
  if state.binding_mode = NoLocals || state.binding_mode = kind then { state with binding_mode = kind }
  else failed state 1ul

let start_range (pos:U32.t) : G.span = { G.first = pos; G.last = pos }
let empty_range (state:parser_state) : parsed =
  { parser = state; range = start_range state.offset; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }

let consume (input:tape) (state:parser_state) (byte:U8.t) : Read parser_state input =
  if state.status <> 0ul then state
  else
    let ok = same input state.offset byte in
    if ok then { state with offset = next state.offset } else failed state 1ul

let from_cursor (state:parser_state) (read:cursor) : parser_state =
  if state.status <> 0ul then state
  else if read.ok then { state with offset = read.at } else failed state 1ul

let skip (input:tape) (state:parser_state) : Read parser_state input =
  if state.status <> 0ul then state
  else
    let cursor = trivia input state.offset in
    from_cursor state cursor

let operator_end (start:U32.t) (op:U32.t) : U32.t =
  plus start (if op = 2ul || op = 4ul then 2ul else 1ul)

let emit_comparison (input:tape) (state:parser_state) (slot op start:U32.t) (left right:G.span)
  : Stack parser_state
    (requires fun h -> live input h)
    (ensures fun h0 result h1 -> live input h1 /\
      (if U32.v slot < U32.v input.capacity then
        let edit = { G.first = start; G.last = operator_end start op } in
        result == state /\ B.as_seq h1 input.output == FStar.Seq.upd (B.as_seq h0 input.output)
          (U32.v slot) (G.make_candidate op edit left right)
       else h1 == h0 /\ result == failed state 4ul)) =
  if U32.(slot <^ input.capacity) then (
    let edit = { G.first = start; G.last = operator_end start op } in
    S.save_candidate input.output input.capacity slot (G.make_candidate op edit left right);
    state
  ) else failed state 4ul

let hex_value (ch:U8.t) : U32.t =
  let n = Cast.uint8_to_uint32 ch in
  if G.decimal_digit ch then U32.sub n 48ul
  else if U8.(ch >=^ 97uy && ch <=^ 102uy) then U32.sub n 87ul
  else if U8.(ch >=^ 65uy && ch <=^ 70uy) then U32.sub n 55ul
  else 16ul

let simple_escape (input:tape) (at:U32.t) (template:bool) : Read bool input =
  let escape = peek input (next at) in
  let following = peek input (plus at 2ul) in
  escape = 92uy || escape = 34uy || escape = 39uy ||
  escape = 110uy || escape = 114uy || escape = 116uy || escape = 98uy ||
  escape = 102uy || escape = 118uy || (escape = 48uy && not (G.decimal_digit following)) ||
  (template && (escape = 36uy || escape = 96uy))

let rec fixed_hex (input:tape) (at digits:U32.t) : Read cursor input (decreases U32.v digits) =
  if digits = 0ul then { at; ok = true; newline = false }
  else
    let value = hex_value (peek input at) in
    if value = 16ul then { at; ok = false; newline = false }
    else fixed_hex input (next at) (minus digits 1ul)

let rec unicode_escape (input:tape) (at value fuel:U32.t) (seen:bool) : Read cursor input (decreases U32.v fuel) =
  if fuel = 0ul || U32.(value >^ 0x10fffful) then { at; ok = false; newline = false }
  else if same input at 125uy then { at = next at; ok = seen; newline = false }
  else
    let digit = hex_value (peek input at) in
    if digit = 16ul then { at; ok = false; newline = false }
    else unicode_escape input (next at) (U32.add (U32.mul value 16ul) digit) (minus fuel 1ul) true

let escape_end (input:tape) (at:U32.t) (template extended:bool) : Read cursor input =
  if simple_escape input at template then { at = plus at 2ul; ok = true; newline = false }
  else if not extended then { at; ok = false; newline = false }
  else
    let start = next at in
    let escape = peek input start in
    let after = next start in
    if escape = 120uy then fixed_hex input after 2ul
    else if escape = 117uy then
      if same input after 123uy then unicode_escape input (next after) 0ul input.size false
      else fixed_hex input after 4ul
    else
      let breaks = line_break input start in
      if not breaks then { at; ok = false; newline = false }
      else
        let width = if escape = 13uy then (if same input after 10uy then 2ul else 1ul)
          else if escape = 10uy then 1ul else 3ul in
        { at = plus start width; ok = true; newline = false }

let rec string_end (input:tape) (at:U32.t) (delimiter:U8.t) (fuel:U32.t) (extended:bool)
  : Read cursor input (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ input.size) then { at; ok = false; newline = false }
  else
    let byte = peek input at in
    if byte = delimiter then { at = next at; ok = true; newline = false }
    else
      let breaks = line_break input at in
      if breaks then { at; ok = false; newline = false }
      else if byte = 92uy then
        let escape = escape_end input at false extended in
        if escape.ok then string_end input escape.at delimiter (minus fuel 1ul) extended
        else escape
      else string_end input (next at) delimiter (minus fuel 1ul) extended

let regex_printable (ch:U8.t) : bool = U8.(ch >=^ 32uy && ch <=^ 126uy)

let no_character : U32.t = 256ul

type regex_unit = { unit_end:U32.t; unit_ok:bool; character:U32.t; repeatable:bool }

let regex_escape (input:tape) (at:U32.t) (in_class:bool) : Read regex_unit input =
  let escape = peek input (next at) in
  let finish = plus at 2ul in
  let nul = if escape = 48uy then
    let following = peek input finish in not (G.decimal_digit following)
    else false in
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
    let high = hex_value (peek input finish) in
    let low = hex_value (peek input (next finish)) in
    if high = 16ul || low = 16ul then
      { unit_end = at; unit_ok = false; character = no_character; repeatable = false }
    else { unit_end = plus at 4ul; unit_ok = true;
      character = U32.add (U32.mul high 16ul) low; repeatable = true }
  else
    let group = escape = 115uy || escape = 83uy || escape = 100uy || escape = 68uy || escape = 119uy || escape = 87uy in
    let boundary = not in_class && (escape = 98uy || escape = 66uy) in
    { unit_end = finish; unit_ok = character <> no_character || group || boundary;
      character; repeatable = not boundary }

let regex_class_unit (input:tape) (at:U32.t) : Read regex_unit input =
  let byte = peek input at in
  if byte = 92uy then regex_escape input at true
  else { unit_end = next at; unit_ok = regex_printable byte && byte <> 93uy;
    character = Cast.uint8_to_uint32 byte; repeatable = true }

let rec regex_class (input:tape) (at fuel:U32.t) : Read cursor input (decreases U32.v fuel) =
  if fuel = 0ul then { at; ok = false; newline = false }
  else if same input at 93uy then { at = next at; ok = true; newline = false }
  else
    let lhs = regex_class_unit input at in
    if not lhs.unit_ok then { at; ok = false; newline = false }
    else
      let dash = same input lhs.unit_end 45uy in
      let close = same input (next lhs.unit_end) 93uy in
      if dash && not close then
        let rhs = regex_class_unit input (next lhs.unit_end) in
        if rhs.unit_ok && U32.(lhs.character <=^ rhs.character && rhs.character <^ no_character) then
          regex_class input rhs.unit_end (minus fuel 1ul)
        else { at; ok = false; newline = false }
      else regex_class input lhs.unit_end (minus fuel 1ul)

type regex_count = { count_end:U32.t; count_value:U32.t; count_ok:bool }

let rec regex_decimal (input:tape) (at value remaining:U32.t)
  : Read regex_count input (decreases U32.v remaining) =
  let byte = peek input at in
  if not (G.decimal_digit byte) then { count_end = at; count_value = value; count_ok = remaining <> 6ul }
  else if remaining = 0ul || U32.(value >^ 99999ul) then
    { count_end = at; count_value = value; count_ok = false }
  else
    let digit = U32.sub (Cast.uint8_to_uint32 byte) 48ul in
    regex_decimal input (next at) (U32.add (U32.mul value 10ul) digit) (minus remaining 1ul)

let regex_counted (input:tape) (at:U32.t) : Read cursor input =
  let lower = regex_decimal input (next at) 0ul 6ul in
  let comma = same input lower.count_end 44uy in
  let upper =
    if not comma then lower
    else if same input (next lower.count_end) 125uy then { lower with count_end = next lower.count_end }
    else regex_decimal input (next lower.count_end) 0ul 6ul in
  let complete = same input upper.count_end 125uy in
  { at = next upper.count_end;
    ok = lower.count_ok && upper.count_ok && complete && U32.(lower.count_value <=^ upper.count_value);
    newline = false }

let regex_flag_bit (byte:U8.t) : U32.t =
  if byte = 100uy then 1ul
  else if byte = 103uy then 2ul
  else if byte = 105uy then 4ul
  else if byte = 109uy then 8ul
  else if byte = 115uy then 16ul
  else if byte = 117uy then 32ul
  else if byte = 121uy then 64ul
  else 0ul

let rec regex_flags (input:tape) (at seen fuel:U32.t) : Read cursor input (decreases U32.v fuel) =
  let byte = peek input at in
  let bit = regex_flag_bit byte in
  if bit = 0ul then { at; ok = not (G.identifier_continue byte || byte = 92uy); newline = false }
  else if fuel = 0ul || U32.logand bit seen <> 0ul then { at; ok = false; newline = false }
  else regex_flags input (next at) (U32.logor bit seen) (minus fuel 1ul)

type regex_captures = { names:U64.t; count:U32.t }
type regex_result = { ending:cursor; captures:regex_captures }
type regex_group_result = { pattern:regex_result; repeatable_group:bool }

let regex_result_at (at:U32.t) (ok:bool) (captures:regex_captures) : regex_result =
  { ending = { at; ok; newline = false }; captures }

let rec regex_pattern (input:tape) (at depth fuel:U32.t) (nested can_repeat:bool) (captures:regex_captures)
  : Read regex_result input (decreases %[U32.v depth; 1; U32.v fuel]) =
  if fuel = 0ul || U32.(at >=^ input.size) then regex_result_at at false captures
  else
    let byte = peek input at in
    let rest = minus fuel 1ul in
    if byte = 47uy && not nested then
      let ending = regex_flags input (next at) 0ul 7ul in { ending; captures }
    else if byte = 41uy && nested then regex_result_at (next at) true captures
    else if byte = 40uy then
      let group = regex_group input at depth rest captures in
      let parsed = group.pattern in
      if not parsed.ending.ok then parsed
      else regex_pattern input parsed.ending.at depth rest nested group.repeatable_group parsed.captures
    else if byte = 91uy then
      let negated = same input (next at) 94uy in
      let class_ = regex_class input (plus at (if negated then 2ul else 1ul)) rest in
      if not class_.ok then { ending = class_; captures }
      else regex_pattern input class_.at depth rest nested true captures
    else if byte = 92uy then
      let first = peek input (next at) in
      if U8.(first >=^ 49uy && first <=^ 57uy) then
        let index = regex_decimal input (next at) 0ul 6ul in
        if index.count_ok && U32.(index.count_value <=^ captures.count) then
          regex_pattern input index.count_end depth rest nested true captures
        else regex_result_at at false captures
      else
        let escaped = regex_escape input at false in
        if not escaped.unit_ok then regex_result_at at false captures
        else regex_pattern input escaped.unit_end depth rest nested escaped.repeatable captures
    else if byte = 124uy || byte = 94uy || byte = 36uy then
      regex_pattern input (next at) depth rest nested false captures
    else if byte = 43uy || byte = 42uy || byte = 63uy || byte = 123uy then
      if not can_repeat then regex_result_at at false captures
      else
        let quantifier = if byte = 123uy then regex_counted input at
          else { at = next at; ok = true; newline = false } in
        if not quantifier.ok then { ending = quantifier; captures }
        else
          let lazy_ = same input quantifier.at 63uy in
          let after = if lazy_ then next quantifier.at else quantifier.at in
          regex_pattern input after depth rest nested false captures
    else if regex_printable byte && byte <> 47uy && byte <> 41uy && byte <> 93uy && byte <> 125uy then
      regex_pattern input (next at) depth rest nested true captures
    else regex_result_at at false captures
and regex_group (input:tape) (at depth fuel:U32.t) (captures:regex_captures)
  : Read regex_group_result input (decreases %[U32.v depth; 0; U32.v fuel]) =
  // Only a group descent uses a native stack frame. The flat scanner is tail-recursive.
  let question = same input (next at) 63uy in
  let marker = peek input (plus at 2ul) in
  let prefix = plus at 3ul in
  let names = captures.names in
  let start, names, repeatable_group =
    if not question then next at, names, true
    else if marker = 58uy then prefix, names, true
    else if marker = 61uy || marker = 33uy then prefix, names, false
    else if marker = 60uy then
      let first = peek input prefix in
      if first = 61uy || first = 33uy then next prefix, names, false
      else if not (G.identifier_start first) then at, names, false
      else
        let limit = scan_class input prefix G.Identifier in
        let closed = same input limit 62uy in
        let last = peek input (minus limit 1ul) in
        // Equal names always share a bit. Decline collisions instead of accepting a duplicate.
        let edges = U32.add (Cast.uint8_to_uint32 first) (Cast.uint8_to_uint32 last) in
        let hash = U32.add_mod edges (minus limit prefix) in
        let bit = U64.shift_left 1uL (U32.rem hash 64ul) in
        if closed && U64.logand names bit = 0uL then next limit, U64.logor names bit, true
        else at, names, false
    else at, names, false in
  let capturing = not question || (marker = 60uy && repeatable_group) in
  let pattern =
    if start = at || depth = 0ul || U32.(captures.count >=^ input.size) then regex_result_at at false captures
    else
      let count = if capturing then U32.add captures.count 1ul else captures.count in
      regex_pattern input start (minus depth 1ul) fuel true false { names; count } in
  { pattern; repeatable_group }

let regex_end (input:tape) (at:U32.t) : Read cursor input =
  let parsed = regex_pattern input at 32ul input.size false false { names = 0uL; count = 0ul } in
  parsed.ending

type precedence = p:U32.t{1 <= U32.v p /\ U32.v p <= 11}
type binary_operator = { strength:precedence; width:U32.t; boundary:U32.t; nullish:bool }

let shift_width (input:tape) (at:U32.t) (byte:U8.t) : Read U32.t input =
  let third = peek input (plus at 2ul) in
  if byte = 62uy && third = 62uy then 3ul else 2ul

let operator (input:tape) (at:U32.t) (in_allowed:bool) : Read binary_operator input =
  let byte = peek input at in
  let follower = peek input (next at) in
  let none = { strength = 1ul; width = 0ul; boundary = 0ul; nullish = false } in
  if byte = 60uy || byte = 62uy then
    if byte = follower then
      let width = shift_width input at byte in
      if same input (plus at width) 61uy then none
      else { strength = 8ul; width; boundary = 0ul; nullish = false }
    else
      let boundary = S.source_boundary input.source input.size at in
      { strength = 7ul; width = (if follower = 61uy then 2ul else 1ul); boundary; nullish = false }
  else if (byte = 61uy || byte = 33uy) && follower = 61uy then
    let triple = same input (plus at 2ul) 61uy in
    { strength = 6ul; width = (if triple then 3ul else 2ul); boundary = 0ul; nullish = false }
  else if (byte = 63uy || byte = 38uy || byte = 124uy) && follower = byte then
    let assignment = same input (plus at 2ul) 61uy in
    if assignment then none
    else { strength = (if byte = 38uy then 2ul else 1ul); width = 2ul; boundary = 0ul; nullish = byte = 63uy }
  else if byte = 105uy && follower = 110uy then
    if keyword input (plus at 2ul) 8ul 0x7374616e63656f66uL then
      { strength = 7ul; width = 10ul; boundary = 0ul; nullish = false }
    else if in_allowed then
      if keyword input at 2ul 0x696euL then
        { strength = 7ul; width = 2ul; boundary = 0ul; nullish = false }
      else none
    else none
  else if follower = 61uy then none
  else if byte = 124uy then { strength = 3ul; width = 1ul; boundary = 0ul; nullish = false }
  else if byte = 38uy then { strength = 5ul; width = 1ul; boundary = 0ul; nullish = false }
  else if byte = 94uy then { strength = 4ul; width = 1ul; boundary = 0ul; nullish = false }
  else if (byte = 43uy || byte = 45uy) && follower <> byte then { strength = 9ul; width = 1ul; boundary = 0ul; nullish = false }
  else if (byte = 42uy && follower <> byte) || byte = 47uy || byte = 37uy then
    { strength = 10ul; width = 1ul; boundary = 0ul; nullish = false }
  else none

let unary_width (input:tape) (at:U32.t) (byte:U8.t) : Read U32.t input =
  if byte = 43uy || byte = 45uy then
    let doubled = same input (next at) byte in if doubled then 0ul else 1ul
  else if byte = 33uy || byte = 126uy then 1ul
  else if byte = 116uy then
    if keyword input at 6ul 0x747970656f66uL then 6ul else 0ul
  else if byte = 118uy then
    if keyword input at 4ul 0x766f6964uL then 4ul else 0ul
  else 0ul

type names_base = base:U32.t{base = 0ul \/ base = binding_region_width \/ base = export_region_base}
type named_state = { state:parser_state; used:names_used }

let rec same_bytes (input:tape) (left right length:U32.t)
  : Read bool input (decreases U32.v length) =
  if length = 0ul then true
  else
    let l = peek input left in
    let r = peek input right in
    if l = r then same_bytes input (next left) (next right) (minus length 1ul) else false

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
  : Run bool input (decreases U32.v used) =
  if U32.(used <=^ floor) then false
  else
    let previous = U32.sub used 1ul in
    let saved = B.index input.bindings (U32.add base previous) in
    let equal = if len = minus saved.span.G.last saved.span.G.first && names_overlap namespace saved.namespace then
      same_bytes input pos saved.span.G.first len else false in
    if equal then true else name_seen input base floor previous pos len namespace

let bind_in_namespace (input:tape) (st:parser_state) (base:names_base) (floor used:names_used)
  (pos:U32.t) (namespace:binding_namespace)
  : Run named_state input =
  let end_name = name input pos false true in
  let st = from_cursor st end_name in
  let length = minus st.offset pos in
  if st.status <> 0ul || used = binding_region_width || U32.(length >^ 256ul) then { state = failed st 1ul; used }
  else if name_seen input base floor used pos length namespace then
    let status = if base = 0ul && namespace = ValueName then 5ul else 1ul in
    { state = failed st status; used }
  else (
    B.upd input.bindings (U32.add base used) { span = { G.first = pos; G.last = st.offset }; namespace };
    { state = st; used = U32.add used 1ul }
  )

let bind_since (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Run named_state input = bind_in_namespace input st base floor used pos BothNames

let bind_pattern_name (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Run named_state input =
  let namespace = if base = 0ul then ValueName else BothNames in
  bind_in_namespace input st base floor used pos namespace

let bind_at (input:tape) (st:parser_state) (base:names_base) (used:names_used) (pos:U32.t)
  : Run named_state input = bind_since input st base 0ul used pos

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

let type_name (input:tape) (state:parser_state) : Read cursor input =
  let width =
    if keyword input state.offset 4ul 0x766f6964uL then 4ul
    else if keyword input state.offset 4ul 0x6e756c6cuL then 4ul
    else if keyword input state.offset 4ul 0x74727565uL then 4ul
    else if keyword input state.offset 5ul 0x66616c7365uL then 5ul
    else if keyword input state.offset 5ul 0x636f6e7374uL then 5ul
    else 0ul in
  if width <> 0ul then { at = plus state.offset width; ok = true; newline = false }
  else name input state.offset false false

let packed_type (input:tape) (start finish:U32.t) : Read U64.t input =
  let length = minus finish start in
  if U32.(length <=^ 8ul) then word input start length 0uL else 0uL

let undefined_type (input:tape) (start finish:U32.t) : Read bool input =
  if minus finish start <> 9ul then false
  else
    let prefix = word input start 8ul 0uL in
    let last = peek input (plus start 8ul) in
    prefix = 0x756e646566696e65uL && last = 100uy

let rec qualified_name (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases U32.v fuel) =
  let after = trivia input state.offset in
  let st = from_cursor state after in
  if st.status <> 0ul then st
  else if same input st.offset 46uy then
    if after.newline || fuel = 0ul then failed st 1ul
    else
      let property = skip input { st with offset = next st.offset } in
      let byte = peek input property.offset in
      if property.status <> 0ul || not (G.identifier_start byte) then failed property 1ul
      else
        let end_at = scan_class input property.offset G.Identifier in
        qualified_name input { property with offset = end_at } (minus fuel 1ul)
  else state

let property_name (input:tape) (state:parser_state) : Read cursor input =
  let byte = peek input state.offset in
  if byte = 34uy || byte = 39uy then string_end input (next state.offset) byte input.size false
  else if G.identifier_start byte then
    { at = scan_class input state.offset G.Identifier; ok = true; newline = false }
  else { at = state.offset; ok = false; newline = false }

let radix_digit (radix:U32.t) (ch:U8.t) : bool =
  if radix = 2ul then ch = 48uy || ch = 49uy
  else if radix = 8ul then U8.(ch >=^ 48uy && ch <=^ 55uy)
  else G.decimal_digit ch || (radix = 16ul &&
    (U8.(ch >=^ 65uy && ch <=^ 70uy) || U8.(ch >=^ 97uy && ch <=^ 102uy)))

let rec radix_end (input:tape) (at radix fuel:U32.t) : Read U32.t input (decreases U32.v fuel) =
  if fuel = 0ul then at
  else
    let byte = peek input at in
    if radix_digit radix byte then radix_end input (next at) radix (minus fuel 1ul)
    else at

let rec number_digits (input:tape) (at radix fuel:U32.t) : Read cursor input (decreases U32.v fuel) =
  let first = peek input at in
  if fuel = 0ul || not (radix_digit radix first) then { at; ok = false; newline = false }
  else
    let stop = if radix = 10ul then scan_class input at G.DecimalDigits else radix_end input at radix input.size in
    let separator = same input stop 95uy in
    if separator then number_digits input (next stop) radix (minus fuel 1ul)
    else { at = stop; ok = true; newline = false }

let number_suffix (input:tape) (digits:cursor) (bigint:bool) : Read cursor input =
  if not digits.ok then digits
  else
    let byte = peek input digits.at in
    let finish = if bigint && byte = 110uy then next digits.at else digits.at in
    let following = peek input finish in
    { at = finish; ok = not (G.identifier_continue following || following = 92uy); newline = false }

let number_end (input:tape) (at:U32.t) : Read cursor input =
  let first = peek input at in
  let second = peek input (next at) in
  let radix =
    if first <> 48uy then 10ul
    else if second = 120uy || second = 88uy then 16ul
    else if second = 111uy || second = 79uy then 8ul
    else if second = 98uy || second = 66uy then 2ul
    else 10ul in
  if radix <> 10ul then number_suffix input (number_digits input (plus at 2ul) radix input.size) true
  else if first = 48uy && (G.decimal_digit second || second = 95uy) then
    { at; ok = false; newline = false }
  else
    let integer = if first = 46uy then { at; ok = true; newline = false }
      else number_digits input at 10ul input.size in
    let dot = same input integer.at 46uy in
    let fraction =
      if not integer.ok || not dot then integer
      else
        let start = next integer.at in
        let next_byte = peek input start in
        if G.decimal_digit next_byte || first = 46uy then number_digits input start 10ul input.size
        else { integer with at = start } in
    let marker = peek input fraction.at in
    let exponent = marker = 101uy || marker = 69uy in
    let value =
      if not fraction.ok || not exponent then fraction
      else
        let sign = peek input (next fraction.at) in
        let start = plus fraction.at (if sign = 43uy || sign = 45uy then 2ul else 1ul) in
        number_digits input start 10ul input.size in
    number_suffix input value (not dot && not exponent)

let import_type (input:tape) (state:parser_state) : Read parser_state input =
  let open_ = skip input { state with offset = plus state.offset 6ul } in
  let module_ = skip input (consume input open_ 40uy) in
  let delimiter = peek input module_.offset in
  if delimiter <> 34uy && delimiter <> 39uy then failed module_ 1ul
  else
    let text = from_cursor module_ (string_end input (next module_.offset) delimiter input.size false) in
    let close = consume input (skip input text) 41uy in
    qualified_name input close 64ul

let type_query (input:tape) (state:parser_state) : Read parser_state input =
  let target = skip input { state with offset = plus state.offset 6ul } in
  if keyword input target.offset 6ul 0x696d706f7274uL then import_type input target
  else
    let named = from_cursor target (name input target.offset false false) in
    qualified_name input named 64ul

let spread_at (input:tape) (at:U32.t) : Read bool input =
  let first = same input at 46uy in
  if not first then false
  else
    let second = same input (next at) 46uy in
    let third = same input (plus at 2ul) 46uy in
    second && third

let predicate_name (input:tape) (at:U32.t) : Read cursor input =
  if keyword input at 4ul 0x74686973uL then { at = plus at 4ul; ok = true; newline = false }
  else name input at false false

type tuple_item = { item_end:parser_state; optional_item:bool; rest_item:bool }

type type_term_head = {
  term_state:parser_state; term_readonly:bool; term_byte:U8.t;
  term_keyof:bool; term_queried:bool; term_imported:bool; term_inferred:bool
}

let read_type_term_head (input:tape) (state:parser_state) : Read type_term_head input =
  let readonly = keyword input state.offset 8ul 0x726561646f6e6c79uL in
  let st = if readonly then skip input { state with offset = plus state.offset 8ul } else state in
  let byte = peek input st.offset in
  let keyof = if byte = 107uy then keyword input st.offset 5ul 0x6b65796f66uL else false in
  let queried = if byte = 116uy then keyword input st.offset 6ul 0x747970656f66uL else false in
  let imported = if byte = 105uy then keyword input st.offset 6ul 0x696d706f7274uL else false in
  let inferred = if byte = 105uy then keyword input st.offset 5ul 0x696e666572uL else false in
  { term_state = st; term_readonly = readonly; term_byte = byte;
    term_keyof = keyof; term_queried = queried; term_imported = imported; term_inferred = inferred }

type bracket_type_key = { key_end:parser_state; index_signature:bool }

let read_bracket_type_key (input:tape) (state:parser_state) : Read bracket_type_key input =
  let start = skip input (consume input state 91uy) in
  let first = peek input start.offset in
  let name_end = from_cursor start (name input start.offset false false) in
  let tail = skip input name_end in
  let colon = same input tail.offset 58uy in
  if tail.status = 0ul && colon then { key_end = tail; index_signature = true }
  else
    let key =
      if first = 34uy || first = 39uy then
        from_cursor start (string_end input (next start.offset) first input.size true)
      else if G.decimal_digit first || first = 46uy || first = 45uy then
        from_cursor start (number_end input (if first = 45uy then next start.offset else start.offset))
      else
        let this_ = if first = 116uy then keyword input start.offset 4ul 0x74686973uL else false in
        let key = if this_ then { start with offset = plus start.offset 4ul } else name_end in
        qualified_name input key 64ul in
    { key_end = skip input (consume input (skip input key) 93uy); index_signature = false }

let type_chain_start (input:tape) (state:parser_state) : Read (parser_state & bool) input =
  let st = skip input state in
  let first = peek input st.offset in
  if first = 124uy || first = 38uy then consume input st first, false else st, true

let constructor_type_start (input:tape) (st:parser_state) (byte:U8.t) : Read parser_state input =
  let start =
    if byte = 97uy then
      if keyword input st.offset 8ul 0x6162737472616374uL then skip input { st with offset = plus st.offset 8ul }
      else st
    else st in
  let new_ = if start.status = 0ul then keyword input start.offset 3ul 0x6e6577uL else false in
  if new_ then skip input { start with offset = plus start.offset 3ul } else st

type mapped_type_head = { constraint_start:parser_state; mapped:bool }

let mapped_type_start (input:tape) (st:parser_state) : Read mapped_type_head input =
  let ordinary = { constraint_start = st; mapped = false } in
  let byte = peek input st.offset in
  let signed = byte = 43uy || byte = 45uy in
  let start = if signed then skip input (consume input st byte) else st in
  let first = peek input start.offset in
  let readonly = if first = 114uy then keyword input start.offset 8ul 0x726561646f6e6c79uL else false in
  let bracket =
    if readonly then skip input { start with offset = plus start.offset 8ul } else start in
  let opening = same input bracket.offset 91uy in
  if not opening || (signed && not readonly) then ordinary
  else
    let key = skip input (consume input bracket 91uy) in
    let first = peek input key.offset in
    if not (G.identifier_start first) then ordinary
    else
      let stop = scan_class input key.offset G.Identifier in
      let tail = skip input { key with offset = stop } in
      let in_ = keyword input tail.offset 2ul 0x696euL in
      if not in_ || tail.status <> 0ul then ordinary
      else
        let binding = name input key.offset false true in
        let constraint_start =
          if binding.ok then { tail with offset = plus tail.offset 2ul } else failed key 1ul in
        { constraint_start; mapped = true }

#push-options "--split_queries always --z3rlimit 30"
let rec type_reference (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 1; 0]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else
    let named = type_name input st in
    let packed = packed_type input st.offset named.at in
    let undefined = undefined_type input st.offset named.at in
    let primitive = builtin_type packed || undefined in
    let named = from_cursor st named in
    let reference = if primitive then named else qualified_name input named 64ul in
    if type_operator packed then failed reference 1ul
    else if primitive then reference
    else type_arguments input reference fuel
and type_arguments (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 0; 0]) =
  let after = trivia input state.offset in
  let tail = from_cursor state after in
  if tail.status <> 0ul then tail
  else if same input tail.offset 60uy then
    if after.newline || fuel = 0ul then failed tail 1ul
    else type_list input (consume input tail 60uy) (minus fuel 1ul) 64ul 62uy false
  else state
and type_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (close:U8.t) (allow_empty:bool)
  : Read parser_state input (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let st = skip input state in
  let closed = same input st.offset close in
  if st.status <> 0ul then st
  else if closed && allow_empty then consume input st close
  else if remaining = 0ul then failed st 1ul
  else
    let st = skip input (annotation_type input st fuel 64ul) in
    if st.status <> 0ul then st
    else if same input st.offset 44uy then
      type_list input { st with offset = next st.offset } fuel (minus remaining 1ul) close true
    else consume input st close
and tuple_element (input:tape) (state:parser_state) (fuel:U32.t)
  : Read tuple_item input (decreases %[U32.v fuel; 5; 0]) =
  let rest_item = spread_at input state.offset in
  let start = if rest_item then skip input { state with offset = plus state.offset 3ul } else state in
  let first = peek input start.offset in
  let label = if G.identifier_start first then scan_class input start.offset G.Identifier else start.offset in
  let after_label = if label = start.offset then start else skip input { start with offset = label } in
  let optional_label = if label = start.offset then false else same input after_label.offset 63uy in
  let colon = if optional_label then skip input (consume input after_label 63uy) else after_label in
  let named = if label = start.offset then false else same input colon.offset 58uy in
  let start = if named then consume input colon 58uy else start in
  let value = annotation_type input start fuel 64ul in
  let after_value = trivia input value.offset in
  let annotated = from_cursor value after_value in
  let optional_suffix = if named then false else same input annotated.offset 63uy in
  let optional_item = (named && optional_label) || optional_suffix in
  let item_end = if rest_item && optional_item then failed annotated 1ul
    else if optional_suffix then
      // A question mark after a composite type may belong to its final operand.
      let primary = type_suffixes input (type_reference input start 0ul) 0ul 16ul false in
      if after_value.newline || primary.status <> 0ul || primary.offset <> value.offset then failed annotated 1ul
      else skip input (consume input annotated 63uy)
    else annotated in
  { item_end; optional_item; rest_item }
and tuple_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (seen_optional:bool)
  : Read parser_state input (decreases %[U32.v fuel; 6; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset 93uy then consume input st 93uy
  else if remaining = 0ul then failed st 1ul
  else
    let item = tuple_element input st fuel in
    let end_ = item.item_end in
    if end_.status <> 0ul then end_
    else if seen_optional && not item.optional_item && not item.rest_item then failed end_ 1ul
    else if same input end_.offset 44uy then
      tuple_list input (consume input end_ 44uy) fuel (minus remaining 1ul) (seen_optional || item.optional_item)
    else consume input end_ 93uy
and object_type_member (input:tape) (st:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 6; 0]) =
  let is_readonly = keyword input st.offset 8ul 0x726561646f6e6c79uL in
  let key_start =
    if is_readonly then
      let after = skip input { st with offset = plus st.offset 8ul } in
      let next_key = peek input after.offset in
      if G.identifier_start next_key || next_key = 34uy || next_key = 39uy || next_key = 91uy then after else st
    else st in
  let first = peek input key_start.offset in
  let head =
    if first = 91uy then read_bracket_type_key input key_start
    else
      let unnamed = first = 40uy || first = 60uy in
      let key_end = if unnamed then key_start else skip input (from_cursor key_start (property_name input key_start)) in
      { key_end; index_signature = false } in
  if head.index_signature then
    let key_type = annotation_type input (consume input head.key_end 58uy) fuel 64ul in
    let last = consume input (skip input key_type) 93uy in
    annotation_type input (consume input (skip input last) 58uy) fuel 64ul
  else
    let after = head.key_end in
    let optional = same input after.offset 63uy in
    let after = if optional then skip input (consume input after 63uy) else after in
    let byte = peek input after.offset in
    if byte = 40uy || byte = 60uy then
      if key_start.offset <> st.offset || fuel = 0ul then failed after 1ul
      else
        let inner = minus fuel 1ul in
        let opening = if byte = 60uy then skip input (type_parameters input (consume input after 60uy) inner 64ul)
          else after in
        let parameters = signature_parameters input (consume input opening 40uy) inner 64ul in
        result_type input (consume input (skip input parameters) 58uy) fuel
    else annotation_type input (consume input after 58uy) fuel 64ul
and object_type (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 7; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset 125uy then consume input st 125uy
  else if remaining = 0ul then failed st 1ul
  else
    let declared = object_type_member input st fuel in
    let boundary = trivia input declared.offset in
    let end_ = from_cursor declared boundary in
    let next_byte = peek input end_.offset in
    if end_.status <> 0ul then end_
    else if next_byte = 59uy || next_byte = 44uy then
      object_type input (consume input end_ next_byte) fuel (minus remaining 1ul)
    else if next_byte = 125uy then consume input end_ 125uy
    else if boundary.newline then object_type input end_ fuel (minus remaining 1ul)
    else failed end_ 1ul
and mapped_type (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 7; 0]) =
  let source = annotation_type input state fuel 64ul in
  let st = skip input source in
  let as_ = keyword input st.offset 2ul 0x6173uL in
  let remapped = if as_ then annotation_type input { st with offset = plus st.offset 2ul } fuel 64ul else st in
  let after = skip input (consume input (skip input remapped) 93uy) in
  let byte = peek input after.offset in
  let optional =
    if byte = 43uy || byte = 45uy then consume input (skip input (consume input after byte)) 63uy
    else if byte = 63uy then consume input after 63uy
    else after in
  let st = skip input optional in
  let colon = same input st.offset 58uy in
  let value = if colon then skip input (annotation_type input (consume input st 58uy) fuel 64ul) else st in
  let byte = peek input value.offset in
  let end_ = if byte = 59uy || byte = 44uy then skip input (consume input value byte) else value in
  consume input end_ 125uy
and braced_type (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 8; 0]) =
  let start = skip input state in
  let head = mapped_type_start input start in
  if head.mapped then mapped_type input head.constraint_start fuel
  else object_type input start fuel input.size
and signature_parameters (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset 41uy then consume input st 41uy
  else if remaining = 0ul then failed st 1ul
  else
    let spread = spread_at input st.offset in
    let st = if spread then skip input { st with offset = plus st.offset 3ul } else st in
    let receiver = if remaining = 64ul then keyword input st.offset 4ul 0x74686973uL else false in
    let named = if receiver && not spread then { st with offset = plus st.offset 4ul }
      else from_cursor st (name input st.offset false false) in
    let tail = skip input named in
    let optional = same input tail.offset 63uy in
    let tail = if optional && not receiver && not spread then skip input (consume input tail 63uy) else tail in
    let annotated = annotation_type input (consume input tail 58uy) fuel 64ul in
    let end_ = skip input annotated in
    let comma = same input end_.offset 44uy in
    if comma && not spread then
      signature_parameters input (consume input end_ 44uy) fuel (minus remaining 1ul)
    else consume input end_ 41uy
and type_term (input:tape) (state:parser_state) (fuel:U32.t) (allow_signature allow_constrained_infer:bool)
  : Read parser_state input (decreases %[U32.v fuel; 2; 0]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else
    let head = read_type_term_head input st in
    let st = head.term_state in
    let readonly = head.term_readonly in
    let byte = head.term_byte in
    let keyof = head.term_keyof in
    let queried = head.term_queried in
    let imported = head.term_imported in
    let constructor = if byte = 110uy || byte = 97uy then constructor_type_start input st byte else st in
    let primary =
      if keyof then
        if readonly || fuel = 0ul then failed st 1ul
        else type_term input { st with offset = plus st.offset 5ul } (minus fuel 1ul) false allow_constrained_infer
      else if queried then type_arguments input (type_query input st) fuel
      else if imported then type_arguments input (import_type input st) fuel
      else if head.term_inferred then
        let start = skip input { st with offset = plus st.offset 5ul } in
        let binding = from_cursor start (name input start.offset false true) in
        let gap = trivia input binding.offset in
        let tail = from_cursor binding gap in
        let constrained = if allow_constrained_infer && tail.status = 0ul && not gap.newline then
            keyword input tail.offset 7ul 0x657874656e6473uL
          else false in
        if not constrained then binding
        else if fuel = 0ul then failed tail 1ul
        else
          let start, allow_signature = type_chain_start input { tail with offset = plus tail.offset 7ul } in
          type_terms input start (minus fuel 1ul) 64ul allow_signature true
      else if byte = 34uy || byte = 39uy then
        from_cursor st (string_end input (next st.offset) byte input.size true)
      else if byte = 96uy then
        if fuel = 0ul then failed st 1ul
        else template_type input { st with offset = next st.offset } (minus fuel 1ul) input.size
      else if G.decimal_digit byte || byte = 45uy || byte = 46uy then
        let start = if byte = 45uy then next st.offset else st.offset in
        from_cursor st (number_end input start)
      else if byte = 60uy || constructor.offset <> st.offset then
        if readonly || fuel = 0ul || not allow_signature then failed st 1ul
        else function_type input constructor (minus fuel 1ul)
      else if byte = 91uy || byte = 123uy || byte = 40uy then
        if fuel = 0ul then failed st 1ul
        else
          let inside = { st with offset = next st.offset } in
          let inner = minus fuel 1ul in
          if byte = 91uy then tuple_list input inside inner 64ul false
          else if byte = 123uy then braced_type input inside inner
          else
            let params = if allow_signature then signature_parameters input inside inner 64ul
              else failed inside 1ul in
            let tail = skip input params in
            let arrow = consume input (consume input tail 61uy) 62uy in
            if arrow.status = 0ul then result_type input arrow inner
            else consume input (skip input (annotation_type input inside inner 64ul)) 41uy
      else type_reference input st fuel in
    let with_arrays = type_suffixes input primary fuel 16ul (not readonly) in
    if readonly && byte <> 91uy && primary.offset = with_arrays.offset then failed with_arrays 1ul
    else with_arrays
and function_type (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 6; 0]) =
  let generic = same input state.offset 60uy in
  let start = if generic then skip input (type_parameters input (consume input state 60uy) fuel 64ul)
    else state in
  let params = signature_parameters input (consume input start 40uy) fuel 64ul in
  let tail = skip input params in
  let arrow = consume input (consume input tail 61uy) 62uy in
  result_type input arrow fuel
and template_type (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 5; U32.v remaining]) =
  if state.status <> 0ul then state
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then failed state 1ul
  else
    let at = state.offset in
    let byte = peek input at in
    if byte = 96uy then { state with offset = next at }
    else
      let interpolation = if byte = 36uy then same input (next at) 123uy else false in
      let st =
        if interpolation then
          let value = annotation_type input { state with offset = plus at 2ul } fuel 64ul in
          consume input (skip input value) 125uy
        else if byte = 92uy then from_cursor state (escape_end input at true true)
        else { state with offset = next at } in
      template_type input st fuel (minus remaining 1ul)
and type_suffixes (input:tape) (state:parser_state) (fuel remaining:U32.t) (indexed:bool)
  : Read parser_state input (decreases %[U32.v fuel; 0; U32.v remaining]) =
  let after = trivia input state.offset in
  let st = from_cursor state after in
  if st.status <> 0ul then st
  else if same input st.offset 91uy then
    if after.newline || remaining = 0ul then failed st 1ul
    else
      let inner = skip input (consume input st 91uy) in
      let empty = same input inner.offset 93uy in
      let index =
        if empty then inner
        else if not indexed || fuel = 0ul then failed inner 1ul
        else skip input (annotation_type input inner (minus fuel 1ul) 64ul) in
      let closed = consume input index 93uy in
      type_suffixes input closed fuel (minus remaining 1ul) indexed
  else state
and annotation_type (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 4; 0]) =
  let start, allow_signature = type_chain_start input state in
  let check = type_terms input start fuel remaining allow_signature false in
  let boundary = trivia input check.offset in
  let tail = from_cursor check boundary in
  let extends = if tail.status = 0ul && not boundary.newline then
      keyword input tail.offset 7ul 0x657874656e6473uL
    else false in
  if not extends then check
  else if fuel = 0ul then failed tail 1ul
  else
    let inner = minus fuel 1ul in
    let start, allow_signature = type_chain_start input { tail with offset = plus tail.offset 7ul } in
    let constraint = type_terms input start inner remaining allow_signature true in
    let yes = annotation_type input (consume input (skip input constraint) 63uy) inner remaining in
    annotation_type input (consume input (skip input yes) 58uy) inner remaining
and result_type (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 5; 0]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else
    let asserts = keyword input st.offset 7ul 0x61737365727473uL in
    let target = if asserts then trivia input (plus st.offset 7ul)
      else { at = st.offset; ok = true; newline = false } in
    let named = predicate_name input target.at in
    let tail = trivia input named.at in
    let ambiguous = if asserts then keyword input target.at 2ul 0x6973uL else false in
    let is_ = if target.ok && not target.newline && named.ok && tail.ok && (asserts || not tail.newline) then
      keyword input tail.at 2ul 0x6973uL
      else false in
    if ambiguous then failed st 1ul
    else if is_ then annotation_type input { st with offset = plus tail.at 2ul } fuel 64ul
    else if asserts && target.ok && not target.newline && named.ok then { st with offset = named.at }
    else annotation_type input st fuel 64ul
and type_terms (input:tape) (state:parser_state) (fuel remaining:U32.t) (allow_signature allow_constrained_infer:bool)
  : Read parser_state input (decreases %[U32.v fuel; 3; U32.v remaining]) =
  if remaining = 0ul then failed state 1ul
  else
    let term = type_term input state fuel allow_signature allow_constrained_infer in
    let st = skip input term in
    let byte = peek input st.offset in
    if st.status <> 0ul then st
    else
      let union = if byte = 124uy || byte = 38uy then
        let repeated = same input (next st.offset) byte in not repeated
      else false in
      if union then type_terms input { st with offset = next st.offset } fuel (minus remaining 1ul) false allow_constrained_infer
      else term

and type_parameters (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 5; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul || remaining = 0ul then failed st 1ul
  else
    let named = name input st.offset false true in
    let packed = packed_type input st.offset named.at in
    let undefined = undefined_type input st.offset named.at in
    let st = skip input (from_cursor st named) in
    if builtin_type packed || type_operator packed || undefined then failed st 1ul
    else
      let extends = keyword input st.offset 7ul 0x657874656e6473uL in
      let st = if extends then
        skip input (annotation_type input { st with offset = plus st.offset 7ul } fuel 64ul)
        else st in
      let st = if same input st.offset 61uy then
        skip input (annotation_type input (consume input st 61uy) fuel 64ul)
        else st in
      if st.status <> 0ul then st
      else if same input st.offset 44uy then
        let after = skip input (consume input st 44uy) in
        if same input after.offset 62uy then consume input after 62uy
        else type_parameters input after fuel (minus remaining 1ul)
      else consume input st 62uy

#pop-options

let simple_annotation (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input state in
  let annotation = same input st.offset 58uy in
  if st.status <> 0ul then st
  else if not annotation then state
  else annotation_type input { st with offset = next st.offset } 16ul 64ul

let result_annotation (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input state in
  if same input st.offset 58uy then result_type input (consume input st 58uy) 16ul
  else st

let call_type_arguments (input:tape) (state:parser_state) : Read parser_state input =
  let types = type_list input (consume input state 60uy) 16ul 64ul 62uy false in
  let arguments = skip input types in
  if same input arguments.offset 40uy then arguments else failed arguments 1ul

let optional_type_parameters (input:tape) (state:parser_state) : Read parser_state input =
  if state.status <> 0ul then state
  else if same input state.offset 60uy then type_parameters input (consume input state 60uy) 16ul 64ul
  else state

let forbidden_field_arguments (input:tape) (st:parser_state) : Read bool input =
  if st.super_context <> ClassField then false
  else if same input st.offset 97uy then keyword input (next st.offset) 8ul 0x7267756d656e7473uL
  else false

let simple_default (input:tape) (state:parser_state) : Read parser_state input =
  let equal = same input state.offset 61uy in
  if state.status <> 0ul || not equal then state
  else
    let st = skip input (consume input state 61uy) in
    let first = peek input st.offset in
    let value =
      if forbidden_field_arguments input st then failed st 1ul
      else if first = 34uy || first = 39uy then from_cursor st (string_end input (next st.offset) first input.size true)
      else if G.decimal_digit first || first = 46uy then from_cursor st (number_end input st.offset)
      else if first = 45uy then from_cursor st (number_end input (next st.offset))
      else if first = 123uy || first = 91uy then
        let closed = if first = 123uy then 125uy else 93uy in
        consume input (skip input (consume input st first)) closed
      else
        let width = if first = 116uy then (if keyword input st.offset 4ul 0x74727565uL then 4ul else 0ul)
          else if first = 102uy then (if keyword input st.offset 5ul 0x66616c7365uL then 5ul else 0ul)
          else if first = 110uy then (if keyword input st.offset 4ul 0x6e756c6cuL then 4ul else 0ul)
          else 0ul in
        if width = 0ul then from_cursor st (name input st.offset false false)
        else { st with offset = plus st.offset width } in
    skip input value

let rec pattern_names (input:tape) (state:parser_state) (base:names_base) (floor used:names_used)
  (depth remaining:U32.t) (close:U8.t)
  : Run named_state input (decreases %[U32.v depth; 1; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then { state = st; used }
  else if same input st.offset close then { state = consume input st close; used }
  else if remaining = 0ul then { state = failed st 1ul; used }
  else
    let byte = peek input st.offset in
    if close = 93uy && byte = 44uy then
      pattern_names input (consume input st 44uy) base floor used depth (minus remaining 1ul) close
    else if spread_at input st.offset then
      let target = skip input { st with offset = plus st.offset 3ul } in
      let rest = bind_pattern_name input target base floor used target.offset in
      { rest with state = consume input (skip input rest.state) close }
    else
      let bound =
        if close = 93uy then pattern_binding_at input st base floor used depth
        else
          let key = property_name input st in
          let after = skip input (from_cursor st key) in
          if same input after.offset 58uy then
            let target = skip input (consume input after 58uy) in
            pattern_binding_at input target base floor used depth
          else bind_pattern_name input st base floor used st.offset in
      let st = simple_default input (skip input bound.state) in
      if same input st.offset 44uy then
        pattern_names input (consume input st 44uy) base floor bound.used depth (minus remaining 1ul) close
      else { bound with state = consume input st close }

and pattern_binding_at (input:tape) (state:parser_state) (base:names_base) (floor used:names_used) (depth:U32.t)
  : Run named_state input (decreases %[U32.v depth; 0; 0]) =
  let byte = peek input state.offset in
  if byte = 123uy || byte = 91uy then
    if depth = 0ul then { state = failed state 1ul; used }
    else
      let close = if byte = 123uy then 125uy else 93uy in
      pattern_names input (consume input state byte) base floor used (minus depth 1ul) 64ul close
  else bind_pattern_name input state base floor used state.offset

let pattern_binding (input:tape) (state:parser_state) (base:names_base) (floor used:names_used) : Run named_state input =
  pattern_binding_at input state base floor used 16ul

let collection_head (input:tape) (state:parser_state) (allow_in:bool) : Run parser_state input =
  let byte = peek input state.offset in
  let constant = if byte = 99uy then keyword input state.offset 5ul 0x636f6e7374uL else false in
  let lexical = if byte = 108uy then keyword input state.offset 3ul 0x6c6574uL else false in
  let width =
    if constant then 5ul
    else if lexical then 3ul
    else 0ul in
  if state.status <> 0ul || width = 0ul then failed state 1ul
  else
    let start = skip input { state with offset = plus state.offset width } in
    let mark = state.local_names in
    let bound = pattern_binding input start binding_region_width mark mark in
    let next_token = skip input bound.state in
    let of_token = keyword input next_token.offset 2ul 0x6f66uL in
    let in_token = keyword input next_token.offset 2ul 0x696euL in
    if next_token.status = 0ul && (of_token || (allow_in && in_token)) then
      { next_token with offset = plus next_token.offset 2ul }
    else failed state 1ul

type parameter_list = { names:named_state; non_simple:bool }
type function_shape = { after_function:parser_state; signature_only:bool }
type parameter_arity =
  | OrdinaryParameters
  | GetterParameters
  | SetterParameters

let parameter_prefix (input:tape) (state:parser_state) (floor used:names_used) : Run parameter_list input =
  let first = peek input state.offset in
  let bound = pattern_binding input state binding_region_width floor used in
  let tail = skip input bound.state in
  let typed = if same input tail.offset 63uy then
      let colon = skip input (consume input tail 63uy) in
      annotation_type input (consume input colon 58uy) 16ul 64ul
    else simple_annotation input tail in
  { names = { bound with state = skip input typed }; non_simple = first = 123uy || first = 91uy }

let rest_parameter (input:tape) (state:parser_state) (floor used:names_used) : Run parameter_list input =
  let named = skip input { state with offset = plus state.offset 3ul } in
  let rest = bind_since input named binding_region_width floor used named.offset in
  let end_ = consume input (skip input (simple_annotation input rest.state)) 41uy in
  { names = { rest with state = end_ }; non_simple = true }

let arrow_token (input:tape) (state:parser_state) : Read parser_state input =
  if state.status <> 0ul then state
  else
    let tail = trivia input state.offset in
    let st = from_cursor state tail in
    let equal = same input st.offset 61uy in
    let greater = same input (next st.offset) 62uy in
    if not tail.newline && equal && greater then { st with offset = plus st.offset 2ul }
    else failed st 1ul

let generic_arrow_head (input:tape) (state:parser_state) : Read parser_state input =
  let head = consume input state 60uy in
  let eligible =
    if not head.jsx_allowed then true
    else
      let first = skip input head in
      let named = name input first.offset false true in
      let tail = skip input (from_cursor first named) in
      let byte = peek input tail.offset in
      if tail.status <> 0ul then false
      else if byte = 44uy || byte = 61uy then true
      else if byte = 101uy then keyword input tail.offset 7ul 0x657874656e6473uL
      else false in
  if eligible then skip input (type_parameters input head 16ul 64ul) else failed head 1ul

let async_modifier (input:tape) (start:U32.t) : Read cursor input =
  if same input start 97uy then
    if keyword input start 5ul 0x6173796e63uL then
      let after = trivia input (plus start 5ul) in
      { after with ok = after.ok && not after.newline }
    else { at = start; ok = false; newline = false }
  else { at = start; ok = false; newline = false }

type accessor_head = { arity:parameter_arity; key_start:parser_state }

let accessor_modifier (input:tape) (st:parser_state) : Read accessor_head input =
  let first = peek input st.offset in
  let kind =
    if first = 103uy then
      if keyword input st.offset 3ul 0x676574uL then GetterParameters else OrdinaryParameters
    else if first = 115uy then
      if keyword input st.offset 3ul 0x736574uL then SetterParameters else OrdinaryParameters
    else OrdinaryParameters in
  let ordinary = { arity = OrdinaryParameters; key_start = st } in
  if kind = OrdinaryParameters then ordinary
  else
    let key = skip input { st with offset = plus st.offset 3ul } in
    let byte = peek input key.offset in
    let decimal = if byte = 46uy then G.decimal_digit (peek input (next key.offset)) else G.decimal_digit byte in
    if G.identifier_start byte || byte = 34uy || byte = 39uy || byte = 91uy || decimal then
      { arity = kind; key_start = key }
    else ordinary

let async_function (input:tape) (start:U32.t) : Read cursor input =
  let after = async_modifier input start in
  if after.ok then
    let is_function = keyword input after.at 8ul 0x66756e6374696f6euL in
    { after with ok = is_function }
  else after

let function_start (input:tape) (start:U32.t) : Read cursor input =
  let byte = peek input start in
  if byte = 102uy then
    let ok = keyword input start 8ul 0x66756e6374696f6euL in
    { at = start; ok; newline = false }
  else if byte = 97uy then async_function input start
  else { at = start; ok = false; newline = false }

let function_body (input:tape) (state:parser_state) (non_simple:bool) : Read parser_state input =
  if not non_simple || state.status <> 0ul then state
  else
    // Non-simple parameters have an early error for a strict directive in the prologue.
    let first = skip input (consume input state 123uy) in
    let byte = peek input first.offset in
    if byte = 34uy || byte = 39uy then failed state 1ul else state

let proto_key (input:tape) (first last:U32.t) : Read bool input =
  if minus last first <> 9ul then false
  else
    let start = word input first 8ul 0uL in
    let last = peek input (plus first 8ul) in
    start = 0x5f5f70726f746f5fuL && last = 95uy

let statement_kind (input:tape) (at:U32.t) : Read U32.t input =
  let byte = peek input at in
  if byte = 105uy then (if keyword input at 2ul 0x6966uL then 1ul else 0ul)
  else if byte = 119uy then (if keyword input at 5ul 0x7768696c65uL then 2ul else 0ul)
  else if byte = 100uy then (if keyword input at 2ul 0x646fuL then 3ul else 0ul)
  else if byte = 102uy then (if keyword input at 3ul 0x666f72uL then 4ul else 0ul)
  else if byte = 116uy then (if keyword input at 3ul 0x747279uL then 5ul else 0ul)
  else if byte = 123uy then 6ul
  else if byte = 115uy then (if keyword input at 6ul 0x737769746368uL then 7ul else 0ul)
  else 0ul

let update_width (input:tape) (at:U32.t) (byte:U8.t) : Read U32.t input =
  if byte = 43uy || byte = 45uy then
    if same input (next at) byte then 2ul else 0ul
  else 0ul

let ambiguous_assertion_update (input:tape) (state:parser_state) : Read bool input =
  let question = skip input state in
  let marker = same input question.offset 63uy in
  if question.status <> 0ul || not marker then false
  else
    let body = skip input (consume input question 63uy) in
    let first = peek input body.offset in
    let update = update_width input body.offset first in
    body.status = 0ul && update <> 0ul

let assignment_width (input:tape) (at:U32.t) (byte follower:U8.t) : Read U32.t input =
  if byte = 61uy && follower <> 61uy && follower <> 62uy then 1ul
  else if (byte = 60uy || byte = 62uy) && follower = byte then
    let width = shift_width input at byte in
    if same input (plus at width) 61uy then next width else 0ul
  else if (byte = 38uy || byte = 124uy || byte = 63uy) && follower = byte then
    if same input (plus at 2ul) 61uy then 3ul else 0ul
  else if follower <> 61uy then 0ul
  else if byte = 43uy || byte = 45uy || byte = 42uy || byte = 47uy || byte = 37uy ||
    byte = 38uy || byte = 124uy || byte = 94uy then 2ul
  else 0ul

let identifier_target (input:tape) (pos:U32.t) (ch:U8.t) : Read assignment_target input =
  let restricted =
    if ch = 101uy then keyword input pos 4ul 0x6576616cuL
    else if ch = 97uy then keyword input (next pos) 8ul 0x7267756d656e7473uL
    else false in
  if restricted then NotAssignable else Assignable

let import_expression_start (input:tape) (state:parser_state) : Read bool input =
  let after = trivia input (plus state.offset 6ul) in
  let byte = peek input after.at in
  after.ok && (byte = 40uy || byte = 46uy)

let statement_end (input:tape) (state:parser_state) (end_at:U32.t) (before_brace:bool)
  : Read parser_state input =
  if state.status <> 0ul then state
  else
    let tail = trivia input end_at in
    let st = from_cursor state tail in
    let byte = peek input st.offset in
    if byte = 59uy then consume input st 59uy
    else if tail.newline || st.offset = input.size || (before_brace && byte = 125uy) then st
    else failed st 1ul

let local_width (input:tape) (start:U32.t) : Read U32.t input =
  let first = peek input start in
  if first = 99uy then (if keyword input start 5ul 0x636f6e7374uL then 5ul else 0ul)
  else if first = 108uy then (if keyword input start 3ul 0x6c6574uL then 3ul else 0ul)
  else 0ul

let type_declaration_width (input:tape) (start:U32.t) : Read U32.t input =
  let first = peek input start in
  let width =
    if first = 105uy then (if keyword input start 9ul 0x6e74657266616365uL then 9ul else 0ul)
    else if first = 116uy then (if keyword input start 4ul 0x74797065uL then 4ul else 0ul)
    else 0ul in
  if width = 0ul then width
  else
    let named = trivia input (plus start width) in
    let byte = peek input named.at in
    if named.ok && not named.newline && G.identifier_start byte then width else 0ul

let admissible_type_binding (input:tape) (first last:U32.t) : Read bool input =
  let packed = packed_type input first last in
  let undefined = undefined_type input first last in
  not (builtin_type packed || undefined || type_operator packed)

let type_alias_tail (input:tape) (state:parser_state) (before_brace:bool) : Read parser_state input =
  let st = skip input (optional_type_parameters input state) in
  let alias = annotation_type input (consume input st 61uy) 16ul 64ul in
  statement_end input alias alias.offset before_brace

let local_type_alias (input:tape) (state:parser_state) (floor used:names_used) : Run named_state input =
  let start = skip input { state with offset = plus state.offset 4ul } in
  let decl = bind_since input start binding_region_width floor used start.offset in
  let valid = admissible_type_binding input start.offset decl.state.offset in
  let st = if valid then type_alias_tail input decl.state true else failed decl.state 1ul in
  { decl with state = { st with local_names = decl.used } }

let tag_space (input:tape) (state:parser_state) : Read parser_state input =
  let at = scan_class input state.offset G.Space in
  { state with offset = at }

let rec quote_end (input:tape) (at:U32.t) (delimiter:U8.t) (fuel:U32.t) : Read U32.t input (decreases U32.v fuel) =
  if U32.(at >=^ input.size) || fuel = 0ul then at
  else
    let byte = peek input at in
    if byte = delimiter then at else quote_end input (next at) delimiter (minus fuel 1ul)

type jsx_opening = { after_tag:parser_state; self_closing:bool }

type postfix_head = {
  after_trivia:parser_state; after_types:parser_state; token:U8.t;
  update:U32.t; type_call:bool; optional_chain:bool; non_null:bool
}

let postfix_start (input:tape) (base:parsed) : Read postfix_head input =
  let after = trivia input base.parser.offset in
  let st = from_cursor base.parser after in
  let byte = peek input st.offset in
  let increment = if after.newline then 0ul else update_width input st.offset byte in
  let generic =
    if byte = 60uy && st.offset = base.range.G.last && (can_assign base.target || base.target = OptionalChain) then
      call_type_arguments input st
    else failed st 1ul in
  let typed = generic.status = 0ul in
  let optional =
    if byte = 63uy then
      let dot = same input (next st.offset) 46uy in
      let digit = peek input (plus st.offset 2ul) in
      dot && not (G.decimal_digit digit)
    else false in
  let bang = if byte = 33uy && not after.newline then
      let equality = same input (next st.offset) 61uy in not equality
    else false in
  { after_trivia = st; after_types = generic; token = byte; update = increment;
    type_call = typed; optional_chain = optional; non_null = bang }

let class_keyword (input:tape) (offset:U32.t) : Read bool input =
  keyword input offset 5ul 0x636c617373uL

type class_key = { after_key:parser_state; first:U32.t; last:U32.t; static_:bool; async_:bool; readonly_:bool }

let class_key_start (input:tape) (state:parser_state) : Read bool input =
  let byte = peek input state.offset in
  G.identifier_start byte || byte = 34uy || byte = 39uy

type class_prefix = { key_state:parser_state; flags:U32.t }

let class_modifier_width (input:tape) (at:U32.t) (first:U8.t) : Read U32.t input =
  if first = 115uy then (if keyword input at 6ul 0x737461746963uL then 6ul else 0ul)
  else if first = 114uy then (if keyword input at 8ul 0x726561646f6e6c79uL then 8ul else 0ul)
  else if first <> 112uy then 0ul
  else if keyword input at 6ul 0x7075626c6963uL then 6ul
  else if keyword input at 7ul 0x70726976617465uL then 7ul
  else
    let prefix = word input at 8ul 0uL in
    if prefix = 0x70726f7465637465uL then
      if keyword input (plus at 8ul) 1ul 0x64uL then 9ul else 0ul
    else 0ul

let rec class_modifiers (input:tape) (st:parser_state) (flags fuel:U32.t)
  : Read class_prefix input (decreases U32.v fuel) =
  let ordinary = { key_state = st; flags } in
  if st.status <> 0ul then ordinary
  else
    let first = peek input st.offset in
    let width = class_modifier_width input st.offset first in
    if width = 0ul then ordinary
    else
      let gap = trivia input (plus st.offset width) in
      let after = from_cursor st gap in
      let modifier = class_key_start input after in
      if not modifier || (gap.newline && first <> 115uy) then ordinary
      else
        let bit = if first = 115uy then 1ul else if first = 114uy then 2ul else 4ul in
        if fuel = 0ul || U32.logand bit flags <> 0ul then { ordinary with key_state = failed st 1ul }
        else class_modifiers input after (U32.logor bit flags) (minus fuel 1ul)

let class_member_key (input:tape) (state:parser_state) : Read class_key input =
  let prefix = class_modifiers input state 0ul 3ul in
  let start = prefix.key_state in
  let modifier = async_modifier input start.offset in
  let after_async = if modifier.ok then { start with offset = modifier.at } else start in
  let async_ = if modifier.ok then class_key_start input after_async else false in
  let key_start = if async_ then after_async else start in
  let byte = peek input key_start.offset in
  let quoted = byte = 34uy || byte = 39uy in
  let key = property_name input key_start in
  let accessor = accessor_modifier input key_start in
  let key_end = from_cursor key_start key in
  let key_end = if accessor.arity = OrdinaryParameters then key_end else failed key_end 1ul in
  let first = if quoted then next key_start.offset else key_start.offset in
  let last = if quoted then minus key.at 1ul else key.at in
  { after_key = key_end; first; last; async_;
    static_ = U32.logand prefix.flags 1ul <> 0ul; readonly_ = U32.logand prefix.flags 2ul <> 0ul }

let wide_key_matches (input:tape) (key:class_key) (suffix_size:U32.t) (prefix suffix:U64.t) : Read bool input =
  if minus key.last key.first <> plus 8ul suffix_size then false
  else
    let a = word input key.first 8ul 0uL in
    let b = word input (plus key.first 8ul) suffix_size 0uL in
    a = prefix && b = suffix

type array_run = { inside:parser_state; openers:U32.t }

let rec array_openers (input:tape) (state:parser_state) (count remaining:U32.t)
  : Read array_run input (decreases U32.v remaining) =
  let st = skip input state in
  let opening = same input st.offset 91uy in
  if st.status <> 0ul || not opening || remaining = 0ul then { inside = st; openers = count }
  else array_openers input (consume input st 91uy) (next count) (minus remaining 1ul)

let rec array_closers (input:tape) (state:parser_state) (count:U32.t)
  : Read parser_state input (decreases U32.v count) =
  if state.status <> 0ul || count = 0ul then state
  else
    let st = consume input (skip input state) 93uy in
    array_closers input st (minus count 1ul)

let rec interface_bases (input:tape) (state:parser_state) (remaining:U32.t)
  : Read parser_state input (decreases U32.v remaining) =
  let st = skip input state in
  if st.status <> 0ul || remaining = 0ul then failed st 1ul
  else
    let named = name input st.offset false false in
    if not named.ok then failed st 1ul
    else
      let ending = skip input (type_reference input st 16ul) in
      if same input ending.offset 44uy then
        interface_bases input (consume input ending 44uy) (minus remaining 1ul)
      else ending

type atom_head = {
  token_:U8.t; imported_:bool; super_:bool; fn_:cursor;
  increment_:U32.t; deleting_:bool; prefix_:U32.t; constructor_:bool
}

let read_atom_head (input:tape) (st:parser_state) : Read atom_head input =
  let start_pos = st.offset in
  let ch = peek input start_pos in
  let imported = if ch = 105uy then keyword input start_pos 6ul 0x696d706f7274uL else false in
  let super_ = if ch = 115uy && st.super_context <> NoSuper then
    keyword input start_pos 5ul 0x7375706572uL else false in
  let fn = function_start input start_pos in
  let increment = update_width input start_pos ch in
  let await_ =
    if st.await_allowed && ch = 97uy then keyword input start_pos 5ul 0x6177616974uL
    else false in
  let deleting = if ch = 100uy then keyword input start_pos 6ul 0x64656c657465uL else false in
  let prefix = if deleting then 6ul else if await_ then 5ul
    else if increment <> 0ul then increment else unary_width input start_pos ch in
  let constructor = if ch = 110uy then keyword input start_pos 3ul 0x6e6577uL else false in
  { token_ = ch; imported_ = imported; super_; fn_ = fn; increment_ = increment; deleting_ = deleting; prefix_ = prefix;
    constructor_ = constructor }

let combine_binary (input:tape) (lhs rhs:parsed) (st:parser_state) (op:binary_operator) (first:U8.t)
  : Run parsed input =
  if rhs.parser.status <> 0ul then rhs
  // Multiple opening angles and a packed right shift can be nested type arguments.
  else if op.boundary = 1ul && lhs.open_angle && rhs.right_shift then empty_range (failed rhs.parser 1ul)
  else
    let logical = (U32.(op.strength <=^ 2ul) && not op.nullish) || lhs.shortcut = 1ul || rhs.shortcut = 1ul in
    let nullish = op.nullish || lhs.shortcut = 2ul || rhs.shortcut = 2ul in
    if logical && nullish then empty_range (failed rhs.parser 1ul)
    else
      let result = if op.boundary = 0ul then rhs.parser
        else emit_comparison input rhs.parser st.count op.boundary st.offset lhs.range rhs.range in
      let shortcut = if logical then 1ul else if nullish then 2ul else 0ul in
      { parser = result; range = { lhs.range with G.last = rhs.range.G.last }; shortcut;
        open_angle = lhs.open_angle || rhs.open_angle || op.boundary = 1ul;
        right_shift = lhs.right_shift || rhs.right_shift || (op.strength = 8ul && first = 62uy);
        outer_or = op.strength = 1ul && not op.nullish; target = NotAssignable }

let signature_end (input:tape) (state opening:parser_state) (params:parameter_list) (annotation st:parser_state)
  : Read parser_state input =
  let typed = skip input params.names.state in
  let annotated_return = same input typed.offset 58uy in
  if not annotated_return || st.count <> state.count then failed st 1ul
  else
    let checked = if params.non_simple then signature_parameters input opening 15ul 64ul else params.names.state in
    if checked.status <> 0ul || checked.offset <> params.names.state.offset then failed st 1ul
    else statement_end input annotation annotation.offset false

#push-options "--split_queries always"
let rec atom (input:tape) (current:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 2; 0]) =
  let st = skip input current in
  let start_pos = st.offset in
  if st.status <> 0ul then empty_range st
  else if forbidden_field_arguments input st then empty_range (failed st 1ul)
  else
    let head = read_atom_head input st in
    let ch = head.token_ in
    let imported = head.imported_ in
    let super_ = head.super_ in
    let fn = head.fn_ in
    let increment = head.increment_ in
    let deleting = head.deleting_ in
    let prefix = head.prefix_ in
    let constructor = head.constructor_ in
    if prefix <> 0ul then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let child = atom input { st with offset = plus start_pos prefix } (minus fuel 1ul) in
        if (increment <> 0ul && not (can_assign child.target)) ||
           (deleting && child.target <> MemberTarget && child.target <> OptionalChain) then
          empty_range (failed child.parser 1ul)
        else { child with range = { child.range with G.first = start_pos }; target = NotAssignable }
    else if fn.ok then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let first = skip input { st with offset = plus fn.at 8ul } in
        let byte = peek input first.offset in
        let named =
          if byte = 40uy || byte = 60uy then first
          else from_cursor first (name input first.offset false true) in
        let closed = function_tail input named (minus fuel 1ul) (start_pos <> fn.at) NoSuper in
        postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
          open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if super_ then super_expression input st fuel
    else if imported then
      let after = skip input { st with offset = plus start_pos 6ul } in
      let byte = peek input after.offset in
      let closed =
        if byte = 40uy then
          if fuel = 0ul then failed after 3ul
          else
            let depth = minus 65ul fuel in
            let after = if U32.(depth >^ after.depth) then { after with depth } else after in
            dynamic_import input (consume input after 40uy) (minus fuel 1ul)
        else if byte = 46uy && st.module_mode then
          let meta = skip input (consume input after 46uy) in
          if keyword input meta.offset 4ul 0x6d657461uL then { meta with offset = plus meta.offset 4ul }
          else failed meta 1ul
        else failed after 1ul in
      postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
        open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if ch = 60uy && st.jsx_allowed then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let closed = jsx_element input st (minus fuel 1ul) in
        postfix input { parser = closed; range = { G.first = start_pos; G.last = closed.offset };
          open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
    else if constructor || ch = 96uy || ch = 91uy || ch = 123uy then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let st = { st with depth } in
        let inner = minus fuel 1ul in
        let completed =
          if constructor then
            let target = skip input { st with offset = plus start_pos 3ul } in
            let named =
              if forbidden_field_arguments input target then failed target 1ul
              else from_cursor target (name input target.offset false false) in
            let named = qualified_name input named 64ul in
            let tail = skip input named in
            let typed = same input tail.offset 60uy in
            let tail = if typed && tail.offset = named.offset then call_type_arguments input tail else tail in
            let args = consume input tail 40uy in
            expression_list input args inner input.size 41uy
          else
            let inside = { st with offset = next start_pos } in
            if ch = 96uy then template_body input inside inner input.size false
            else if ch = 91uy then
              if U32.(inner <=^ 8ul) then deep_array_literal input inside inner
              else expression_list input inside inner input.size 93uy
            else object_members input inside inner input.size false in
        postfix input { parser = completed; range = { G.first = start_pos; G.last = completed.offset }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }
          fuel input.size
    else if ch = 40uy then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let inner = comparison input { st with offset = next start_pos; depth; in_allowed = true } (minus fuel 1ul) in
        let consumed = skip input inner.parser in
        let done_ = consume input { consumed with in_allowed = st.in_allowed } 41uy in
        postfix input { parser = done_; range = { G.first = start_pos; G.last = done_.offset }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }
          fuel input.size
    else if G.decimal_digit ch || ch = 46uy then
      let number = number_end input start_pos in
      postfix input { parser = from_cursor st number; range = { G.first = start_pos; G.last = number.at }; open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable }
        fuel input.size
    else
      let named, target =
        if ch = 34uy || ch = 39uy then (from_cursor st (string_end input (next start_pos) ch input.size true), NotAssignable)
        else if ch = 47uy then (from_cursor st (regex_end input (next start_pos)), NotAssignable)
        else
          let width =
            if ch = 116uy then
              let is_this = keyword input start_pos 4ul 0x74686973uL in
              if is_this then 4ul else if keyword input start_pos 4ul 0x74727565uL then 4ul else 0ul
            else if ch = 102uy then (if keyword input start_pos 5ul 0x66616c7365uL then 5ul else 0ul)
            else if ch = 110uy then (if keyword input start_pos 4ul 0x6e756c6cuL then 4ul else 0ul)
            else 0ul in
          if width <> 0ul then ({ st with offset = plus start_pos width }, NotAssignable)
          else (from_cursor st (name input start_pos false false), identifier_target input start_pos ch) in
      let base = { parser = named; range = { G.first = start_pos; G.last = named.offset };
        open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target } in
      postfix input base fuel input.size
and super_expression (input:tape) (st:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 1; U32.v input.size + 1]) =
  let start_pos = st.offset in
  let after = skip input { st with offset = plus start_pos 5ul } in
  let byte = peek input after.offset in
  let completed =
    if byte = 40uy && st.super_context = DerivedConstructor then
      if fuel = 0ul then failed after 3ul
      else
        let depth = minus 65ul fuel in
        let after = if U32.(depth >^ after.depth) then { after with depth } else after in
        expression_list input (consume input after 40uy) (minus fuel 1ul) input.size 41uy
    else if byte = 46uy || byte = 91uy then { st with offset = plus start_pos 5ul }
    else failed after 1ul in
  postfix input { parser = completed; range = { G.first = start_pos; G.last = completed.offset };
    open_angle = false; outer_or = false; right_shift = false; shortcut = 0ul; target = NotAssignable } fuel input.size
and arrow_parameter_list (input:tape) (state:parser_state) (floor used:names_used)
  (fuel remaining:U32.t) (non_simple:bool)
  : Run parameter_list input (decreases %[U32.v fuel; 22; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then { names = { state = st; used }; non_simple }
  else if same input st.offset 41uy then { names = { state = consume input st 41uy; used }; non_simple }
  else if remaining = 0ul then { names = { state = failed st 1ul; used }; non_simple }
  else if spread_at input st.offset then rest_parameter input st floor used
  else
    let prefix = parameter_prefix input st floor used in
    let equal = prefix.names.state in
    let initialized = same input equal.offset 61uy in
    let non_simple = non_simple || prefix.non_simple || initialized in
    let st = simple_default input equal in
    let delimiter = peek input st.offset in
    let st =
      if initialized && equal.status = 0ul && equal.arrow_defaults_allowed &&
          (st.status <> 0ul || (delimiter <> 44uy && delimiter <> 41uy)) then
        if fuel = 0ul then failed equal 3ul
        else
          // Speculation starts after the live names and candidates. Disable recursive speculation into defaults.
          let start = consume input { equal with await_allowed = false; in_allowed = true;
            local_names = prefix.names.used; arrow_defaults_allowed = false } 61uy in
          let value = comparison input start (minus fuel 1ul) in
          let st = skip input value.parser in
          let comma = same input st.offset 44uy in
          let st = if value.open_angle && comma then failed st 1ul else st in
          { st with await_allowed = equal.await_allowed; in_allowed = equal.in_allowed;
            local_names = equal.local_names; arrow_defaults_allowed = equal.arrow_defaults_allowed }
      else st in
    if same input st.offset 44uy then
      arrow_parameter_list input (consume input st 44uy) floor prefix.names.used fuel (minus remaining 1ul) non_simple
    else { names = { prefix.names with state = consume input st 41uy }; non_simple }

and plain_arrow_parameters (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parameter_list input (decreases %[U32.v fuel; 23; 0]) =
  let used = state.local_names in
  let missed = { names = { state = failed state 1ul; used }; non_simple = false } in
  if state.status <> 0ul then missed
  else
    let byte = peek input state.offset in
    let opening = if byte = 60uy then generic_arrow_head input state else state in
    let parenthesized = same input opening.offset 40uy in
    if opening.status <> 0ul then missed
    else if parenthesized then
      let params = arrow_parameter_list input (consume input opening 40uy) used used fuel 64ul false in
      let after = trivia input params.names.state.offset in
      let st = from_cursor params.names.state after in
      let colon = same input st.offset 58uy in
      let result =
        if colon && not after.newline then
          result_type input (consume input st 58uy) 16ul
        else params.names.state in
      { params with names = { params.names with state = arrow_token input result } }
    else if G.identifier_start byte then
      let named = name input state.offset false true in
      let body = arrow_token input (from_cursor state named) in
      if body.status <> 0ul then missed
      else
        let param = bind_since input state binding_region_width used used state.offset in
        { missed with names = { param with state = { param.state with offset = body.offset } } }
    else missed

and arrow_parameters (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parameter_list input (decreases %[U32.v fuel; 24; 0]) =
  let modifier = async_modifier input state.offset in
  if modifier.ok && state.status = 0ul then
    let async_ = plain_arrow_parameters input { state with offset = modifier.at; await_allowed = true } fuel in
    if async_.names.state.status = 0ul || async_.names.state.status = 4ul then async_
    else plain_arrow_parameters input { state with await_allowed = false } fuel
  else plain_arrow_parameters input { state with await_allowed = false } fuel

and comparison (input:tape) (current:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 25; 0]) =
  let start = skip input current in
  let arrow = arrow_parameters input start fuel in
  if arrow.names.state.status = 0ul then
    let body = skip input { arrow.names.state with local_names = arrow.names.used; binding_mode = NoLocals } in
    if fuel = 0ul then empty_range (failed body 3ul)
    else
      let depth = minus 65ul fuel in
      let depth = if U32.(depth >^ body.depth) then depth else body.depth in
      let body = { body with depth } in
      let inner = minus fuel 1ul in
      let block = same input body.offset 123uy in
      let result =
        if block then
          let block_start = { body with in_allowed = true } in
          let stop = control_block input (function_body input block_start arrow.non_simple) inner true NoJump start.local_names arrow.names.used in
          empty_range stop
        else
          let in_allowed = body.in_allowed && not body.for_initializer in
          comparison input { body with in_allowed } inner in
      { result with parser = { result.parser with local_names = start.local_names; await_allowed = start.await_allowed;
          in_allowed = start.in_allowed; binding_mode = start.binding_mode };
        range = { result.range with G.first = start.offset }; outer_or = false; shortcut = 0ul; target = NotAssignable }
  else
  let lhs = binary input start fuel 1ul in
  let st = lhs.parser in
  if st.status = 1ul && arrow.names.state.status = 4ul then empty_range { st with status = 4ul }
  else if st.status <> 0ul then lhs
  else
    let byte = peek input st.offset in
    let follower = peek input (next st.offset) in
    let assignment = if can_assign lhs.target then assignment_width input st.offset byte follower else 0ul in
    if assignment <> 0ul then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let rhs = comparison input { st with offset = plus st.offset assignment } (minus fuel 1ul) in
        { rhs with range = { rhs.range with G.first = lhs.range.G.first };
          open_angle = lhs.open_angle || rhs.open_angle; outer_or = false; shortcut = 0ul; target = NotAssignable }
    else if byte <> 63uy || follower = 63uy || follower = 46uy then lhs
    else if fuel = 0ul then empty_range (failed st 3ul)
    else
      let inner = minus fuel 1ul in
      let consequent = comparison input { st with offset = next st.offset; in_allowed = true } inner in
      let colon = skip input { consequent.parser with in_allowed = st.in_allowed } in
      let alternate = comparison input (consume input colon 58uy) inner in
      { alternate with range = { alternate.range with G.first = lhs.range.G.first };
        open_angle = lhs.open_angle || consequent.open_angle || alternate.open_angle;
        outer_or = false; shortcut = 0ul; target = NotAssignable }
and binary (input:tape) (state:parser_state) (fuel:U32.t) (minimum:precedence)
  : Run parsed input (decreases %[U32.v fuel; 26 - U32.v minimum - U32.v minimum; 0]) =
  let lhs = atom input state fuel in
  binary_tail input lhs fuel minimum input.size
and binary_tail (input:tape) (lhs:parsed) (fuel:U32.t) (minimum:precedence) (remaining:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 25 - U32.v minimum - U32.v minimum; U32.v remaining]) =
  let st = skip input lhs.parser in
  if st.status <> 0ul then empty_range st
  else
    let first = peek input st.offset in
    let type_width =
      if U32.(minimum >^ 7ul) then 0ul
      else if first = 97uy then (if keyword input st.offset 2ul 0x6173uL then 2ul else 0ul)
      else if first = 115uy then
        (if keyword input (next st.offset) 8ul 0x6174697366696573uL then 9ul else 0ul)
      else 0ul in
    let assertion =
      if type_width = 0ul then false
      else let before = trivia input lhs.range.G.last in not before.newline in
    if assertion then
      if remaining = 0ul then empty_range (failed st 3ul)
      else
        let asserted = annotation_type input { st with offset = plus st.offset type_width } 16ul 64ul in
        if ambiguous_assertion_update input asserted then empty_range (failed asserted 1ul)
        else
          let value = { lhs with parser = asserted; range = { lhs.range with G.last = asserted.offset };
            outer_or = false; target = NotAssignable } in
          binary_tail input value fuel minimum (minus remaining 1ul)
    else
      let op = operator input st.offset st.in_allowed in
      if op.width = 0ul || U32.(op.strength <^ minimum) then { lhs with parser = st }
      else if remaining = 0ul then empty_range (failed st 3ul)
      else if op.strength = 11ul then empty_range (failed st 1ul)
      else if lhs.open_angle && (op.boundary = 3ul || op.boundary = 4ul ||
          op.strength = 3ul || op.strength = 5ul || op.strength = 8ul) then empty_range (failed st 1ul)
      else if op.boundary <> 0ul && U32.(st.count >=^ input.capacity) then empty_range (failed st 4ul)
      else
        let count = if op.boundary = 0ul then st.count else next st.count in
        let after = { st with offset = plus st.offset op.width; count } in
        let rhs = binary input after fuel (U32.add op.strength 1ul) in
        let combined = combine_binary input lhs rhs st op first in
        if combined.parser.status <> 0ul then combined
        else binary_tail input combined fuel minimum (minus remaining 1ul)

and postfix (input:tape) (base:parsed) (fuel remaining:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 1; U32.v remaining]) =
  if base.parser.status <> 0ul then base
  else
    let head = postfix_start input base in
    let st = head.after_trivia in
    let byte = head.token in
    let increment = head.update in
    let typed = head.type_call in
    let optional = head.optional_chain in
    let bang = head.non_null in
    if st.status <> 0ul then { base with parser = st }
    else if increment <> 0ul then
      if not (can_assign base.target) then empty_range (failed st 1ul)
      else
        let end_at = plus st.offset increment in
        { base with parser = { st with offset = end_at }; range = { base.range with G.last = end_at };
          target = NotAssignable }
    else if byte <> 46uy && byte <> 40uy && byte <> 91uy && byte <> 96uy &&
      not bang && not optional && not typed then { base with parser = st }
    else if remaining = 0ul then empty_range (failed st 3ul)
    else
      let operand =
        if typed then head.after_types
        else if optional then
          let after = skip input { st with offset = plus st.offset 2ul } in
          if same input after.offset 60uy then call_type_arguments input after else after
        else st in
      let kind = if typed then 40uy else if optional then peek input operand.offset else byte in
      let next_st =
        if kind = 40uy || kind = 91uy || kind = 96uy then
          if kind = 96uy && (optional || base.target = OptionalChain) then failed st 1ul
          else if fuel = 0ul then failed st 3ul
          else
            let depth = minus 65ul fuel in
            let depth = if U32.(depth >^ st.depth) then depth else st.depth in
            let inside = { operand with offset = next operand.offset; depth } in
            if kind = 40uy then expression_list input inside (minus fuel 1ul) input.size 41uy
            else if kind = 96uy then template_body input inside (minus fuel 1ul) input.size true
            else
              let index = comparison input inside (minus fuel 1ul) in
              consume input index.parser 93uy
        else if optional || byte = 46uy then
          let property = if optional then operand else skip input { st with offset = next st.offset } in
          let first = peek input property.offset in
          if not (G.identifier_start first) then failed property 1ul
          else { property with offset = scan_class input property.offset G.Identifier }
        else { st with offset = next st.offset } in
      let target =
        if optional || base.target = OptionalChain then OptionalChain
        else if kind = 46uy || kind = 91uy then MemberTarget
        else NotAssignable in
      postfix input { base with parser = next_st; range = { base.range with G.last = next_st.offset }; target }
        fuel (minus remaining 1ul)

and dynamic_import (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 28; 0]) =
  let path = comparison input state fuel in
  let tail = skip input path.parser in
  if tail.status <> 0ul then tail
  else if same input tail.offset 41uy then consume input tail 41uy
  else
    let options = skip input (consume input tail 44uy) in
    if same input options.offset 41uy then consume input options 41uy
    else
      let value = comparison input options fuel in
      let tail = skip input value.parser in
      let tail = if same input tail.offset 44uy then skip input (consume input tail 44uy) else tail in
      consume input tail 41uy
and deep_array_literal (input:tape) (inside:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 27; 0]) =
  let run = array_openers input inside 0ul input.size in
  if U32.(run.openers <=^ fuel) then expression_list input inside fuel input.size 93uy
  else
    // The leading wrappers cannot fit in the remaining recursive stack.
    // Read the innermost array once and accept only uninterrupted closing wrappers.
    let deepest = expression_list input { run.inside with depth = minus 64ul fuel } fuel input.size 93uy in
    let closed = array_closers input deepest run.openers in
    let depth = plus closed.depth run.openers in
    let depth = if U32.(depth >^ inside.depth) then depth else inside.depth in
    if closed.status <> 0ul then failed inside 3ul else { closed with depth }

and expression_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (close:U8.t)
  : Run parser_state input (decreases %[U32.v fuel; 26; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset close then consume input st close
  else if remaining = 0ul then failed st 3ul
  else
    let hole = if close = 93uy then same input st.offset 44uy else false in
    if hole then expression_list input (consume input st 44uy) fuel (minus remaining 1ul) close
    else
      let spread = spread_at input st.offset in
      let start = if spread then { st with offset = plus st.offset 3ul } else st in
      let arg = comparison input start fuel in
      let st = skip input arg.parser in
      if same input st.offset 44uy then
        let next_item = consume input st 44uy in
        let next_hole = if arg.open_angle && close = 93uy then
          let next_item = skip input next_item in same input next_item.offset 44uy
          else false in
        // A generic argument list cannot continue across an array elision.
        if arg.open_angle && not next_hole then failed st 1ul
        else expression_list input next_item fuel (minus remaining 1ul) close
      else consume input st close
and object_member (input:tape) (st:parser_state) (fuel:U32.t) (colon_required:bool)
  : Run parsed input (decreases %[U32.v fuel; 26; 0]) =
  let spread = spread_at input st.offset in
  if spread && not colon_required then comparison input { st with offset = plus st.offset 3ul } fuel
  else
    let head = accessor_modifier input st in
    let arity = head.arity in
    let accessor = arity <> OrdinaryParameters in
    let modifier = async_modifier input st.offset in
    let method_byte = if modifier.ok then peek input modifier.at else 0uy in
    let async_method = modifier.ok && (G.identifier_start method_byte || method_byte = 34uy ||
      method_byte = 39uy || method_byte = 91uy) in
    let key_start = if async_method then { st with offset = modifier.at } else head.key_start in
    let byte = peek input key_start.offset in
    let quoted = byte = 34uy || byte = 39uy in
    let computed = byte = 91uy in
    let end_key =
      if computed then
        let key = comparison input { key_start with offset = next key_start.offset; in_allowed = true } fuel in
        let closed = consume input (skip input key.parser) 93uy in
        { closed with in_allowed = st.in_allowed }
      else
        let key =
          if accessor && (G.decimal_digit byte || byte = 46uy) then number_end input key_start.offset
          else property_name input key_start in
        let first = if quoted then next key_start.offset else key_start.offset in
        let last = if quoted then minus key.at 1ul else key.at in
        let prototype = if key.ok && not accessor then proto_key input first last else false in
        if prototype then failed st 1ul else from_cursor key_start key in
    let after_key = skip input end_key in
    let colon = same input after_key.offset 58uy in
    if after_key.status <> 0ul then empty_range after_key
    else if colon && not async_method && not accessor then comparison input (consume input after_key 58uy) fuel
    else
      let next_token = peek input after_key.offset in
      if not colon_required && (next_token = 40uy || next_token = 60uy) then
        if fuel = 0ul then empty_range (failed after_key 3ul)
        else if accessor then
          empty_range (function_form input after_key (minus fuel 1ul) false MethodSuper false arity).after_function
        else empty_range (function_tail input after_key (minus fuel 1ul) async_method NoSuper)
      else if computed || quoted || colon_required || async_method || accessor then empty_range (failed st 1ul)
      else
        let shorthand = name input st.offset false false in
        let forbidden = forbidden_field_arguments input st in
        if shorthand.ok && not forbidden then empty_range after_key else empty_range (failed st 1ul)
and object_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (colon_required:bool)
  : Run parser_state input (decreases %[U32.v fuel; 27; U32.v remaining]) =
  let st = skip input state in
  let byte = peek input st.offset in
  if st.status <> 0ul then st
  else if byte = 125uy then consume input st 125uy
  else if remaining = 0ul then failed st 3ul
  else
    let value = object_member input st fuel colon_required in
    let st = skip input value.parser in
    if same input st.offset 44uy then
      // A colon in the next property rules out a generic argument list across the comma.
      object_members input (consume input st 44uy) fuel (minus remaining 1ul) value.open_angle
    else consume input st 125uy
and template_body (input:tape) (state:parser_state) (fuel remaining:U32.t) (tagged:bool)
  : Run parser_state input (decreases %[U32.v fuel; 26; U32.v remaining]) =
  if state.status <> 0ul then state
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then failed state 1ul
  else
    let at = state.offset in
    let byte = peek input at in
    let following = peek input (next at) in
    if byte = 96uy then { state with offset = next at }
    else
      let st =
        if byte = 36uy && following = 123uy then
          let value = comparison input { state with offset = plus at 2ul; in_allowed = true } fuel in
          consume input { value.parser with in_allowed = state.in_allowed } 125uy
        else if byte = 92uy then
          // Tagged templates may contain invalid cooked escapes. Only the next
          // byte can escape a template delimiter, regardless of cooked value.
          if tagged then { state with offset = plus at 2ul }
          else from_cursor state (escape_end input at true true)
        else { state with offset = next at } in
      template_body input st fuel (minus remaining 1ul) tagged

and jsx_attribute (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 30; 0]) =
  let first = peek input state.offset in
  if first = 123uy then
    let inner = skip input (consume input state 123uy) in
    let spread = spread_at input inner.offset in
    if not spread then failed inner 1ul
    else
      let value = comparison input { inner with offset = plus inner.offset 3ul } fuel in
      consume input (skip input value.parser) 125uy
  else
    let named = name input state.offset true false in
    let named_state = from_cursor state named in
    let tail = tag_space input named_state in
    let equal = same input tail.offset 61uy in
    if named_state.status <> 0ul || not equal then named_state
    else
      let st = tag_space input (consume input tail 61uy) in
      let byte = peek input st.offset in
      if byte = 34uy || byte = 39uy then
        let pos = quote_end input (next st.offset) byte input.size in
        consume input { st with offset = pos } byte
      else if byte = 60uy then
        if fuel = 0ul then failed st 3ul
        else
          let opening = tag_space input { st with offset = next st.offset } in
          let fragment = same input opening.offset 62uy in
          let nested = jsx_element input st (minus fuel 1ul) in
          let next_attr = tag_space input nested in
          let first = peek input next_attr.offset in
          if fragment && G.identifier_start first then failed nested 1ul else nested
      else
        let value = comparison input (consume input st 123uy) fuel in
        let st = skip input value.parser in
        // Delegate the focused rewrite for a direct disabled disjunction.
        let disabled = if value.outer_or && minus named.at state.offset = 8ul then
          let attr_name = word input state.offset 8ul 0uL in attr_name = 0x64697361626c6564uL
          else false in
        if disabled then failed st 1ul else consume input st 125uy

and jsx_attributes (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Run jsx_opening input (decreases %[U32.v fuel; 31; U32.v remaining]) =
  let st = tag_space input state in
  let byte = peek input st.offset in
  if st.status <> 0ul then { after_tag = st; self_closing = false }
  else if byte = 62uy then { after_tag = consume input st 62uy; self_closing = false }
  else if byte = 47uy then
    { after_tag = consume input (tag_space input (consume input st 47uy)) 62uy; self_closing = true }
  else if remaining = 0ul then { after_tag = failed st 1ul; self_closing = false }
  else
    let following = jsx_attribute input st fuel in
    jsx_attributes input following fuel (minus remaining 1ul)

and jsx_children (input:tape) (state:parser_state) (tag:G.span) (fuel remaining:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 32; U32.v remaining]) =
  if state.status <> 0ul then state
  else if remaining = 0ul || U32.(state.offset >=^ input.size) then failed state 1ul
  else
    let byte = peek input state.offset in
    if byte = 60uy then
      let slash = same input (next state.offset) 47uy in
      if slash then
        let closing = tag_space input { state with offset = plus state.offset 2ul } in
        let length = minus tag.G.last tag.G.first in
        if length = 0ul then consume input closing 62uy
        else
          let named = name input closing.offset true false in
          let same_ =
            if named.ok && minus named.at closing.offset = length then
              same_bytes input tag.G.first closing.offset length
            else false in
          if same_ then consume input (tag_space input (from_cursor closing named)) 62uy
          else failed closing 1ul
      else if fuel = 0ul then failed state 3ul
      else
        let child = jsx_element input state (minus fuel 1ul) in
        jsx_children input child tag fuel (minus remaining 1ul)
    else if byte = 123uy then
      let st = skip input (consume input state 123uy) in
      let done_ =
        if same input st.offset 125uy then consume input st 125uy
        else
          let value = comparison input st fuel in
          consume input (skip input value.parser) 125uy in
      jsx_children input done_ tag fuel (minus remaining 1ul)
    else if byte = 0uy || byte = 62uy || byte = 125uy then failed state 1ul
    else jsx_children input { state with offset = next state.offset } tag fuel (minus remaining 1ul)

and jsx_element (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 33; 0]) =
  let depth = minus 64ul fuel in
  let state = if U32.(depth >^ state.depth) then { state with depth } else state in
  let opening = tag_space input (consume input state 60uy) in
  if same input opening.offset 62uy then
    jsx_children input (consume input opening 62uy) (start_range opening.offset) fuel input.size
  else
    let named = name input opening.offset true false in
    let attrs = jsx_attributes input (from_cursor opening named) fuel input.size in
    if attrs.after_tag.status <> 0ul || attrs.self_closing then attrs.after_tag
    else jsx_children input attrs.after_tag { G.first = opening.offset; G.last = named.at } fuel input.size

and condition (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 43; 0]) =
  let st = consume input (skip input state) 40uy in
  let tested = comparison input st fuel in
  consume input (skip input tested.parser) 41uy

and variable_initializer (input:tape) (state:parser_state) (fuel:U32.t) (optional before_brace:bool)
  : Run parser_state input (decreases %[U32.v fuel; 43; 0]) =
  let value = declarator_value input state fuel optional in
  statement_end input value.parser value.range.G.last before_brace

and declarator_value (input:tape) (state:parser_state) (fuel:U32.t) (optional:bool)
  : Run parsed input (decreases %[U32.v fuel; 42; 0]) =
  let after_name = trivia input state.offset in
  let tail = from_cursor state after_name in
  if tail.status <> 0ul then empty_range tail
  else
    let byte = peek input tail.offset in
    if optional && not after_name.newline && byte = 33uy then
      let colon = skip input (consume input tail 33uy) in
      let annotation = annotation_type input (consume input colon 58uy) 16ul 64ul in
      let next_token = skip input annotation in
      if same input next_token.offset 61uy then empty_range (failed next_token 1ul)
      else empty_range annotation
    else
      let annotation = if byte = 58uy then annotation_type input (consume input tail 58uy) 16ul 64ul else state in
      let st = if byte = 58uy then skip input annotation else tail in
      if same input st.offset 61uy then
        comparison input (consume input st 61uy) fuel
      else if optional then empty_range annotation
      else empty_range (failed st 1ul)

and binding (input:tape) (state:parser_state) (fuel:U32.t) (in_allowed:bool) : Run parser_state input (decreases %[U32.v fuel; 43; 0]) =
  let st = skip input state in
  let st = from_cursor st (name input st.offset false true) in
  let st = consume input (skip input st) 61uy in
  let for_initializer = state.for_initializer || not in_allowed in
  let value = comparison input { st with in_allowed; for_initializer } fuel in
  { value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer }

and for_bindings (input:tape) (state:parser_state) (fuel remaining:U32.t) (floor:names_used) (constant:bool)
  : Run parser_state input (decreases %[U32.v fuel; 44; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if remaining = 0ul then failed st 1ul
  else
    let first = peek input st.offset in
    let declared = pattern_binding input st binding_region_width floor st.local_names in
    let annotated = simple_annotation input { declared.state with local_names = declared.used } in
    let tail = skip input annotated in
    let equal = same input tail.offset 61uy in
    let initialized =
      if equal then
        let value = comparison input (consume input { tail with in_allowed = false; for_initializer = true } 61uy) fuel in
        { value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer }
      else if constant || first = 91uy || first = 123uy then failed tail 1ul
      else tail in
    let tail = skip input initialized in
    if same input tail.offset 44uy then
      for_bindings input (consume input tail 44uy) fuel (minus remaining 1ul) floor constant
    else tail

and for_expressions (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_allowed:bool)
  : Run parser_state input (decreases %[U32.v fuel; 44; U32.v remaining]) =
  if state.status <> 0ul then state
  else if remaining = 0ul then failed state 1ul
  else
    let for_initializer = state.for_initializer || not in_allowed in
    let value = comparison input { state with in_allowed; for_initializer } fuel in
    let tail = skip input { value.parser with in_allowed = state.in_allowed; for_initializer = state.for_initializer } in
    if same input tail.offset 44uy then
      for_expressions input (consume input tail 44uy) fuel (minus remaining 1ul) in_allowed
    else tail

and classic_for_header (input:tape) (st:parser_state) (top_level local_var:bool) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 45; 0]) =
  let lexical = local_width input st.offset in
  let var = if lexical = 0ul && (top_level || local_var) then keyword input st.offset 3ul 0x766172uL else false in
  let st =
    if same input st.offset 59uy then st
    else if lexical <> 0ul then
      let st = if local_var then record_binding_mode st LexicalLocals else st in
      for_bindings input { st with offset = plus st.offset lexical } fuel 64ul st.local_names (lexical = 5ul)
    else if var then
      let st = if local_var then record_binding_mode st VarLocals else st in
      binding input { st with offset = plus st.offset 3ul } fuel false
    else for_expressions input st fuel 64ul false in
  let st = consume input (skip input st) 59uy in
  let st = skip input st in
  let st = if same input st.offset 59uy then st else for_expressions input st fuel 64ul true in
  let st = consume input (skip input st) 59uy in
  let st = skip input st in
  let st = if same input st.offset 41uy then st else for_expressions input st fuel 64ul true in
  consume input (skip input st) 41uy

and for_header (input:tape) (state:parser_state) (top_level local_var:bool) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 46; 0]) =
  let head = skip input state in
  let async_ = if head.await_allowed then keyword input head.offset 5ul 0x6177616974uL else false in
  let head = if async_ then skip input { head with offset = plus head.offset 5ul } else head in
  let st = skip input (consume input head 40uy) in
  let collection = collection_head input st (not async_) in
  if collection.status = 0ul then
    let collection = if local_var then record_binding_mode collection LexicalLocals else collection in
    let value = comparison input collection fuel in
    consume input (skip input value.parser) 41uy
  else if async_ then collection
  else classic_for_header input st top_level local_var fuel

and return_statement (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 44; 0]) =
  let after = plus state.offset 6ul in
  let body = trivia input after in
  let st = from_cursor state body in
  let byte = peek input st.offset in
  if byte = 59uy || byte = 125uy || body.newline then statement_end input st after true
  else
    let value = comparison input st fuel in
    statement_end input value.parser value.range.G.last true

and ordinary_statement (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 45; 0]) =
  let fn = function_start input state.offset in
  let block = same input state.offset 123uy in
  if block || fn.ok then failed state 1ul
  else
    let value = comparison input state fuel in
    statement_end input value.parser value.range.G.last true

and simple_statement (input:tape) (state:parser_state) (in_function:bool) (jumps:jump_context) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 46; 0]) =
  let byte = peek input state.offset in
  let is_return =
    if byte = 114uy && in_function then keyword input state.offset 6ul 0x72657475726euL else false in
  let is_throw = if byte = 116uy then keyword input state.offset 5ul 0x7468726f77uL else false in
  let jump =
    if byte = 98uy then (if keyword input state.offset 5ul 0x627265616buL then 5ul else 0ul)
    else if byte = 99uy then (if keyword input state.offset 8ul 0x636f6e74696e7565uL then 8ul else 0ul)
    else 0ul in
  if is_return then return_statement input state fuel
  else if jump <> 0ul then
    if jumps = LoopJump || (jumps = BreakOnly && jump = 5ul) then statement_end input state (plus state.offset jump) true
    else failed state 1ul
  else if is_throw then
    let body = trivia input (plus state.offset 5ul) in
    let st = from_cursor state body in
    if body.newline then failed st 1ul
    else
      let value = comparison input st fuel in
      statement_end input value.parser value.range.G.last true
  else if byte = 59uy then consume input state 59uy
  else ordinary_statement input state fuel

and local_var_declaration (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 45; 0]) =
  let st = record_binding_mode state VarLocals in
  let start = skip input { st with offset = plus st.offset 3ul } in
  let named = from_cursor start (name input start.offset false true) in
  variable_initializer input named fuel true true

and local_declaration (input:tape) (state:parser_state) (width:U32.t) (floor used:names_used) (fuel:U32.t)
  : Run named_state input (decreases %[U32.v fuel; 45; 0]) =
  let state = record_binding_mode state LexicalLocals in
  let start = skip input { state with offset = plus state.offset width } in
  let first = peek input start.offset in
  let decl = pattern_binding input start binding_region_width floor used in
  let optional = width = 3ul && G.identifier_start first in
  let st = { decl.state with local_names = decl.used } in
  { decl with state = variable_initializer input st fuel optional true }

and scope_statement (input:tape) (st:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (root_control:bool)
  : Run named_state input (decreases %[U32.v fuel; 48; 0]) =
  let width = if root_control then 0ul else local_width input st.offset in
  let fn = if root_control || not st.module_mode then { at = st.offset; ok = false; newline = false }
    else function_start input st.offset in
  let class_ = if root_control || not st.module_mode then false else
    let first = peek input st.offset in if first = 99uy then class_keyword input st.offset else false in
  if width <> 0ul then local_declaration input st width floor used fuel
  else if fn.ok then
    if fuel = 0ul then { state = failed st 3ul; used }
    else
      let declared = record_binding_mode st LexicalLocals in
      let named = skip input { declared with offset = plus fn.at 8ul } in
      let decl = bind_since input named binding_region_width floor used named.offset in
      let start = { decl.state with local_names = decl.used } in
      { decl with state = function_tail input start (minus fuel 1ul) (st.offset <> fn.at) NoSuper }
  else if class_ then
    if fuel = 0ul then { state = failed st 3ul; used }
    else
      let declared = record_binding_mode st LexicalLocals in
      let named = skip input { declared with offset = plus st.offset 5ul } in
      let decl = bind_since input named binding_region_width floor used named.offset in
      let start = { decl.state with local_names = decl.used } in
      { decl with state = class_tail input start (minus fuel 1ul) }
  else control_statement input st fuel in_function jumps floor used root_control
and control_sequence (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (root_control:bool)
  : Run parser_state input (decreases %[U32.v fuel; 49; U32.v remaining]) =
  let st = skip input { state with local_names = used } in
  let closed = same input st.offset 125uy in
  if st.status <> 0ul || st.offset = input.size || closed then st
  else if remaining = 0ul then failed st 1ul
  else
    let statement = scope_statement input st fuel in_function jumps floor used root_control in
    control_sequence input statement.state fuel (minus remaining 1ul) in_function jumps floor statement.used root_control
and switch_sequence (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (has_label seen_default:bool)
  : Run parser_state input (decreases %[U32.v fuel; 50; U32.v remaining]) =
  let st = skip input { state with local_names = used } in
  let closed = same input st.offset 125uy in
  if st.status <> 0ul || closed then st
  else if st.offset = input.size || remaining = 0ul then failed st 1ul
  else
    let left = minus remaining 1ul in
    let byte = peek input st.offset in
    let case_ = if byte = 99uy then keyword input st.offset 4ul 0x63617365uL else false in
    let default_ = if byte = 100uy then keyword input st.offset 7ul 0x64656661756c74uL else false in
    if case_ then
      let test = comparison input { st with offset = plus st.offset 4ul } fuel in
      let colon = consume input (skip input test.parser) 58uy in
      switch_sequence input colon fuel left in_function jumps floor used true seen_default
    else if default_ then
      if seen_default then failed st 1ul
      else
        let colon = consume input (skip input { st with offset = plus st.offset 7ul }) 58uy in
        switch_sequence input colon fuel left in_function jumps floor used true true
    else if not has_label then failed st 1ul
    else
      let statement = scope_statement input st fuel in_function jumps floor used false in
      switch_sequence input statement.state fuel left in_function jumps floor statement.used true seen_default
and control_block (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (floor used:names_used)
  : Run parser_state input (decreases %[U32.v fuel; 51; 0]) =
  let st = consume input (skip input state) 123uy in
  let st = control_sequence input { st with local_names = used } fuel input.size in_function jumps floor used false in
  consume input { st with local_names = state.local_names } 125uy
and control_statement (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) (allow_var:bool) : Run named_state input (decreases %[U32.v fuel; 47; 0]) =
  let kind = statement_kind input state.offset in
  if state.status <> 0ul then { state; used }
  else if kind = 0ul then
    let local_var = in_function && state.module_mode in
    let first = peek input state.offset in
    let alias = if local_var && first = 116uy then type_declaration_width input state.offset = 4ul else false in
    let var = if local_var && first = 118uy then keyword input state.offset 3ul 0x766172uL else false in
    if alias then local_type_alias input state floor used
    else if var then { state = local_var_declaration input state fuel; used }
    else { state = simple_statement input state in_function jumps fuel; used }
  else if fuel = 0ul then { state = failed state 3ul; used }
  else
    let inner = minus fuel 1ul in
    let depth = minus 65ul fuel in
    let state = if U32.(depth >^ state.depth) then { state with depth } else state in
    if kind = 1ul || kind = 2ul then
      let width = if kind = 1ul then 2ul else 5ul in
      let tested = condition input { state with offset = plus state.offset width } fuel in
      let body_jumps = if kind = 2ul then LoopJump else jumps in
      let body = control_body input tested inner in_function body_jumps floor used in
      let st = skip input body.state in
      let has_else = if kind = 1ul then keyword input st.offset 4ul 0x656c7365uL else false in
      if has_else then
        control_body input { st with offset = plus st.offset 4ul } inner in_function jumps floor body.used
      else { body with state = st }
    else if kind = 3ul then
      let body = control_body input { state with offset = plus state.offset 2ul } inner in_function LoopJump floor used in
      let st = skip input body.state in
      let tested = keyword input st.offset 5ul 0x7768696c65uL in
      let st = if not tested then failed st 1ul
        else
          let st = skip input (condition input { st with offset = plus st.offset 5ul } fuel) in
          if same input st.offset 59uy then consume input st 59uy else st in
      { body with state = st }
    else
      let result =
        if kind = 4ul then
          let tested = for_header input { state with offset = plus state.offset 3ul } allow_var (in_function && state.module_mode) fuel in
          let body = control_body input tested inner in_function LoopJump tested.local_names tested.local_names in
          { body.state with local_names = state.local_names }
        else if kind = 5ul then
          try_statement input { state with offset = plus state.offset 3ul } inner in_function jumps used
        else if kind = 6ul then control_block input state inner in_function jumps used used
        else
          let tested = condition input { state with offset = plus state.offset 6ul } fuel in
          let start = consume input (skip input tested) 123uy in
          let case_jumps = if jumps = LoopJump then LoopJump else BreakOnly in
          let st = switch_sequence input start inner input.size in_function case_jumps used used false false in
          consume input { st with local_names = state.local_names } 125uy in
      { state = result; used }
and control_body (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context)
  (floor used:names_used) : Run named_state input (decreases %[U32.v fuel; 52; 0]) =
  let st = skip input state in
  if st.status <> 0ul then { state = st; used }
  else if same input st.offset 123uy then { state = control_block input st fuel in_function jumps used used; used }
  else control_statement input st fuel in_function jumps floor used false
and catch_block (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (used:names_used)
  : Run parser_state input (decreases %[U32.v fuel; 52; 0]) =
  let st = skip input state in
  if same input st.offset 40uy then
    let st = record_binding_mode st LexicalLocals in
    let start = skip input (consume input st 40uy) in
    let bound = pattern_binding input start binding_region_width used used in
    let annotated = skip input (simple_annotation input bound.state) in
    let body = consume input annotated 41uy in
    control_block input body fuel in_function jumps used bound.used
  else control_block input st fuel in_function jumps used used
and try_statement (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (jumps:jump_context) (used:names_used)
  : Run parser_state input (decreases %[U32.v fuel; 53; 0]) =
  let after = skip input (control_block input state fuel in_function jumps used used) in
  if after.status <> 0ul then after
  else
    let caught = keyword input after.offset 5ul 0x6361746368uL in
    let st = if caught then
      skip input (catch_block input { after with offset = plus after.offset 5ul } fuel in_function jumps used)
      else after in
    let cleanup = keyword input st.offset 7ul 0x66696e616c6c79uL in
    if cleanup then
      control_block input { st with offset = plus st.offset 7ul } fuel in_function jumps used used
    else if caught then st
    else failed st 1ul

and function_parameters (input:tape) (state:parser_state) (floor used:names_used) (fuel remaining:U32.t) (non_simple:bool)
  : Run parameter_list input (decreases %[U32.v fuel; 46; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then { names = { state = st; used }; non_simple }
  else if same input st.offset 41uy then { names = { state = consume input st 41uy; used }; non_simple }
  else if remaining = 0ul then { names = { state = failed st 1ul; used }; non_simple }
  else
    let spread = spread_at input st.offset in
    let receiver = if remaining = 64ul then keyword input st.offset 4ul 0x74686973uL else false in
    if receiver then
      let colon = skip input { st with offset = plus st.offset 4ul } in
      let typed = annotation_type input (consume input colon 58uy) 16ul 64ul in
      let end_ = skip input typed in
      if same input end_.offset 44uy then
        function_parameters input (consume input end_ 44uy) floor used fuel (minus remaining 1ul) non_simple
      else { names = { state = consume input end_ 41uy; used }; non_simple }
    else if spread then rest_parameter input st floor used
    else
      let prefix = parameter_prefix input st floor used in
      let st = prefix.names.state in
      let default_ = same input st.offset 61uy in
      let non_simple = non_simple || prefix.non_simple || default_ in
      let st =
        if default_ then
          let start = consume input { st with await_allowed = false; local_names = prefix.names.used } 61uy in
          let value = comparison input start fuel in
          { value.parser with await_allowed = st.await_allowed; local_names = st.local_names }
        else st in
      let end_ = skip input st in
      if same input end_.offset 44uy then
        function_parameters input (consume input end_ 44uy) floor prefix.names.used fuel (minus remaining 1ul) non_simple
      else { names = { prefix.names with state = consume input end_ 41uy }; non_simple }
and function_tail (input:tape) (state:parser_state) (fuel:U32.t) (async_:bool) (super_:super_context)
  : Run parser_state input (decreases %[U32.v fuel; 54; 0]) =
  (function_form input state fuel async_ super_ false OrdinaryParameters).after_function

and function_form (input:tape) (state:parser_state) (fuel:U32.t) (async_:bool) (super_:super_context) (overload:bool)
  (arity:parameter_arity)
  : Run function_shape input (decreases %[U32.v fuel; 53; 0]) =
  let depth = minus 64ul fuel in
  let start = if U32.(depth >^ state.depth) then { state with depth } else state in
  let start = { start with super_context = NoSuper } in
  let start = skip input (optional_type_parameters input (skip input start)) in
  let opening = consume input start 40uy in
  let opening, limit =
    if arity = OrdinaryParameters then (opening, 64ul)
    else
      let first = skip input opening in
      let close = same input first.offset 41uy in
      if arity = GetterParameters then (first, 0ul)
      else if (if close then true else spread_at input first.offset) then (failed first 1ul, 1ul)
      else (first, 1ul) in
  let floor = state.local_names in
  let params = function_parameters input opening floor floor fuel limit false in
  let constructor = super_ = BaseConstructor || super_ = DerivedConstructor in
  let annotation = if constructor then params.names.state else result_annotation input params.names.state in
  let st = skip input annotation in
  let signature_only = if overload && st.status = 0ul then not (same input st.offset 123uy) else false in
  let closed =
    if signature_only then
      signature_end input state opening params annotation st
    else
      let st = { st with await_allowed = async_; in_allowed = true; binding_mode = NoLocals; super_context = super_ } in
      control_block input (function_body input st params.non_simple) fuel true NoJump floor params.names.used in
  { after_function = { closed with await_allowed = state.await_allowed; in_allowed = state.in_allowed;
      binding_mode = state.binding_mode; super_context = state.super_context }; signature_only }

and class_field_tail (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 55; 0]) =
  let gap = trivia input state.offset in
  let st = from_cursor state gap in
  let byte = peek input st.offset in
  let definite = byte = 33uy && not gap.newline in
  let optional = byte = 63uy && not gap.newline in
  let head = if optional || definite then consume input st byte else state in
  let typed = simple_annotation input head in
  let after = skip input typed in
  let equal = same input after.offset 61uy in
  if definite && (equal || typed.offset = head.offset) then failed after 1ul
  else if not equal then statement_end input typed typed.offset true
  else
    let start = consume input { after with await_allowed = false; super_context = ClassField; in_allowed = true } 61uy in
    let value = comparison input start fuel in
    let closed = statement_end input value.parser value.range.G.last true in
    { closed with await_allowed = state.await_allowed; super_context = state.super_context; in_allowed = state.in_allowed }

and class_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (derived seen_constructor:bool)
  : Run parser_state input (decreases %[U32.v fuel; 56; U32.v remaining]) =
  let st = skip input state in
  let byte = peek input st.offset in
  if st.status <> 0ul then st
  else if byte = 125uy then consume input st 125uy
  else if remaining = 0ul then failed st 1ul
  else if byte = 59uy then
    class_members input (consume input st 59uy) fuel (minus remaining 1ul) derived seen_constructor
  else
    let key = class_member_key input st in
    let tail = skip input key.after_key in
    if tail.status <> 0ul then tail
    else
      let constructor_name = wide_key_matches input key 3ul 0x636f6e7374727563uL 0x746f72uL in
      let constructor = constructor_name && not key.static_ in
      let prototype = if key.static_ then wide_key_matches input key 1ul 0x70726f746f747970uL 0x65uL else false in
      let next_byte = peek input tail.offset in
      let method = next_byte = 40uy || next_byte = 60uy in
      if prototype || (constructor_name && not method) || (key.readonly_ && method) ||
        (constructor && (seen_constructor || key.async_ || next_byte <> 40uy)) then failed tail 1ul
      else
        let after =
          if method then
            if fuel = 0ul then failed tail 3ul
            else
              let mode = if not constructor then MethodSuper else if derived then DerivedConstructor else BaseConstructor in
              function_tail input tail (minus fuel 1ul) key.async_ mode
          else if key.async_ then failed tail 1ul
          else class_field_tail input key.after_key fuel in
        class_members input after fuel (minus remaining 1ul) derived (seen_constructor || constructor)
and class_tail (input:tape) (state:parser_state) (fuel:U32.t)
  : Run parser_state input (decreases %[U32.v fuel; 57; 0]) =
  let st = skip input (optional_type_parameters input (skip input state)) in
  let derived = keyword input st.offset 7ul 0x657874656e6473uL in
  let inherited =
    if not derived then st
    else
      let base = skip input { st with offset = plus st.offset 7ul } in
      let named = name input base.offset false false in
      let forbidden = forbidden_field_arguments input base in
      if named.ok && not forbidden then skip input (type_reference input base 16ul) else failed base 1ul in
  let word_ = word input inherited.offset 8ul 0uL in
  let implements = if word_ = 0x696d706c656d656euL then keyword input (plus inherited.offset 8ul) 2ul 0x7473uL
    else false in
  let ready = if implements then interface_bases input { inherited with offset = plus inherited.offset 10ul } 64ul else inherited in
  let depth = minus 65ul fuel in
  let ready = if U32.(depth >^ ready.depth) then { ready with depth } else ready in
  class_members input (consume input ready 123uy) fuel input.size derived false

#pop-options

let declaration (input:tape) (state:parser_state) : Run parser_state input =
  let has_const = keyword input state.offset 5ul 0x636f6e7374uL in
  if state.status <> 0ul || not has_const then failed state 1ul
  else
    let st = skip input { state with offset = plus state.offset 5ul } in
    let named = name input st.offset false true in
    let st = skip input (from_cursor st named) in
    let st = consume input st 61uy in
    (comparison input st 64ul).parser

let import_source (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input state in
  let delimiter = peek input st.offset in
  if st.status <> 0ul || (delimiter <> 34uy && delimiter <> 39uy) then failed st 1ul
  else
    let literal = string_end input (next st.offset) delimiter input.size false in
    statement_end input (from_cursor st literal) literal.at false

let rec import_members (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t) (allow_type:bool)
  : Run named_state input (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul then { state = st; used }
  else if same input st.offset 125uy then { state = consume input st 125uy; used }
  else
    let st =
      let modifier = if allow_type then keyword input st.offset 4ul 0x74797065uL else false in
      if modifier then
        let after = skip input { st with offset = plus st.offset 4ul } in
        let first = peek input after.offset in
        let as_ = keyword input after.offset 2ul 0x6173uL in
        if G.identifier_start first && not as_ then after else st
      else st in
    let first = peek input st.offset in
    if fuel = 0ul || not (G.identifier_start first) then { state = failed st 1ul; used }
    else
      let imported = scan_class input st.offset G.Identifier in
      let tail = skip input { st with offset = imported } in
      let local =
        if keyword input tail.offset 2ul 0x6173uL then
          let start = skip input { tail with offset = plus tail.offset 2ul } in
          bind_at input start 0ul used start.offset
        else bind_at input st 0ul used st.offset in
      let st = skip input local.state in
      if same input st.offset 44uy then
        import_members input (consume input st 44uy) local.used (minus fuel 1ul) allow_type
      else { state = consume input st 125uy; used = local.used }

let import_bindings (input:tape) (state:parser_state) (used:names_used) (allow_type:bool)
  : Run named_state input =
  let st = skip input state in
  let byte = peek input st.offset in
  if st.status <> 0ul then { state = st; used }
  else if byte = 123uy then import_members input (consume input st 123uy) used 64ul allow_type
  else if byte = 42uy then
    let as_ = skip input { st with offset = next st.offset } in
    if keyword input as_.offset 2ul 0x6173uL then
      let local = skip input { as_ with offset = plus as_.offset 2ul } in
      bind_at input local 0ul used local.offset
    else { state = failed st 1ul; used }
  else { state = failed st 1ul; used }

let import_declaration (input:tape) (state:parser_state) (used:names_used) : Run named_state input =
  let st = skip input { state with offset = plus state.offset 6ul } in
  let byte = peek input st.offset in
  if byte = 34uy || byte = 39uy then { state = import_source input st; used }
  else
    let after_type = if keyword input st.offset 4ul 0x74797065uL then
      skip input { st with offset = plus st.offset 4ul }
      else failed st 1ul in
    let type_only =
      if after_type.status <> 0ul then false
      else if same input after_type.offset 44uy then false
      else if keyword input after_type.offset 4ul 0x66726f6duL then
        let source = skip input { after_type with offset = plus after_type.offset 4ul } in
        let first = peek input source.offset in
        first <> 34uy && first <> 39uy
      else true in
    let members =
      if byte = 123uy || byte = 42uy then import_bindings input st used true
      else if type_only then
        let first = peek input after_type.offset in
        if first = 123uy || first = 42uy then import_bindings input after_type used false
        else bind_at input after_type 0ul used after_type.offset
      else
        let default_ = bind_at input st 0ul used st.offset in
        let after = skip input default_.state in
        if same input after.offset 44uy then
          import_bindings input (consume input after 44uy) default_.used true
        else { default_ with state = after } in
    let st = skip input members.state in
    let result =
      if keyword input st.offset 4ul 0x66726f6duL then import_source input { st with offset = plus st.offset 4ul }
      else failed st 1ul in
    { members with state = result }

let ambient_variable_width (input:tape) (start:U32.t) : Read U32.t input =
  let lexical = local_width input start in
  if lexical <> 0ul then lexical
  else if keyword input start 3ul 0x766172uL then 3ul else 0ul

let ambient_modifier (input:tape) (start:U32.t) : Read cursor input =
  if keyword input start 7ul 0x6465636c617265uL then
    let after = trivia input (plus start 7ul) in
    let width = ambient_variable_width input after.at in
    { after with ok = after.ok && not after.newline && width <> 0ul }
  else { at = start; ok = false; newline = false }

type declaration_head = {
  after_modifiers:parser_state; width:U32.t; async_declaration:bool; ambient_declaration:bool; class_declaration:bool
}

let declaration_start (input:tape) (state:parser_state) : Read declaration_head input =
  let st =
    if keyword input state.offset 6ul 0x6578706f7274uL then skip input { state with offset = plus state.offset 6ul }
    else state in
  let async_ = async_function input st.offset in
  let st = if async_.ok then { st with offset = async_.at } else st in
  let ambient = ambient_modifier input st.offset in
  let st = if ambient.ok then { st with offset = ambient.at } else st in
  let class_ = class_keyword input st.offset in
  let width =
    if class_ then 5ul
    else if keyword input st.offset 8ul 0x66756e6374696f6euL then 8ul
    else
      let declared = type_declaration_width input st.offset in
      if declared <> 0ul then declared
      else if ambient.ok then ambient_variable_width input st.offset
      else local_width input st.offset in
  { after_modifiers = st; width; async_declaration = async_.ok; ambient_declaration = ambient.ok; class_declaration = class_ }

let module_function (input:tape) (state:parser_state) (used:names_used) (async_:bool)
  : Run named_state input =
  let named = from_cursor state (name input state.offset false true) in
  let function_ = function_form input named 64ul async_ NoSuper true OrdinaryParameters in
  let after = function_.after_function in
  if after.status <> 0ul then { state = after; used }
  else
    let namespace = if function_.signature_only then FunctionSignature else FunctionImplementation in
    let binding = bind_in_namespace input state 0ul 0ul used state.offset namespace in
    { binding with state = if binding.state.status = 0ul then after else failed after 1ul }

#push-options "--split_queries always"
let rec module_lexical_list (input:tape) (state:parser_state) (used:names_used) (constant:bool) (remaining:U32.t)
  : Run named_state input (decreases U32.v remaining) =
  let start = skip input state in
  if start.status <> 0ul || remaining = 0ul then { state = failed start 1ul; used }
  else
    let first = peek input start.offset in
    let decl = pattern_binding input start 0ul 0ul used in
    let value = declarator_value input decl.state 64ul (not constant && G.identifier_start first) in
    let tail = skip input value.parser in
    let comma = same input tail.offset 44uy in
    if tail.status <> 0ul then { decl with state = tail }
    else if not comma then { decl with state = statement_end input value.parser value.range.G.last false }
    else if value.open_angle then { decl with state = failed tail 1ul }
    else module_lexical_list input (consume input tail 44uy) decl.used constant (minus remaining 1ul)

let module_declaration (input:tape) (state:parser_state) (used:names_used) : Run named_state input =
  let head = declaration_start input state in
  let st = head.after_modifiers in
  let width = head.width in
  if width = 0ul then { state = failed st 1ul; used }
  else
    let start = skip input { st with offset = plus st.offset width } in
    if width = 8ul then module_function input start used head.async_declaration
    else if (width = 3ul || width = 5ul) && not head.ambient_declaration && not head.class_declaration then
      module_lexical_list input start used (width = 5ul) input.size
    else
      let type_only = width = 4ul || width = 9ul in
      let decl =
        if head.class_declaration then bind_at input start 0ul used start.offset
        else bind_in_namespace input start 0ul 0ul used start.offset (if type_only then TypeName else ValueName) in
      let st = skip input decl.state in
      let result =
        if head.class_declaration then class_tail input st 64ul
        else if type_only then
          let valid = admissible_type_binding input start.offset decl.state.offset in
          if not valid then failed st 1ul
          else if width = 9ul then
            let st = skip input (optional_type_parameters input st) in
            let extends = keyword input st.offset 7ul 0x657874656e6473uL in
            let st = if extends then interface_bases input { st with offset = plus st.offset 7ul } 64ul else st in
            object_type input (consume input st 123uy) 15ul input.size
          else type_alias_tail input st false
        else
          let annotation = annotation_type input (consume input st 58uy) 16ul 64ul in
          statement_end input annotation annotation.offset false in
      { decl with state = { result with await_allowed = state.await_allowed } }
#pop-options

let reserve_export (input:tape) (state:parser_state) (used:names_used) (first last:U32.t)
  : Run named_state input =
  let length = minus last first in
  if state.status <> 0ul then { state; used }
  else if used = binding_region_width || length = 0ul || U32.(length >^ 256ul) then
    { state = failed state 1ul; used }
  else if name_seen input export_region_base 0ul used first length BothNames then
    { state = failed state 1ul; used }
  else (
    B.upd input.bindings (U32.add export_region_base used) { span = { G.first = first; G.last = last }; namespace = BothNames };
    { state; used = U32.add used 1ul }
  )

let rec reserve_direct_exports (input:tape) (state:parser_state) (used previous current:names_used)
  : Run named_state input (decreases U32.v current) =
  if state.status <> 0ul || U32.(current <=^ previous) then { state; used }
  else
    let index = U32.sub current 1ul in
    let binding = B.index input.bindings index in
    let named = if binding.namespace = TypeName || binding.namespace = FunctionSignature then { state; used }
      else reserve_export input state used binding.span.G.first binding.span.G.last in
    reserve_direct_exports input named.state named.used previous index

let export_identifier (input:tape) (state:parser_state) : Read parser_state input =
  let first = peek input state.offset in
  if G.identifier_start first then { state with offset = scan_class input state.offset G.Identifier }
  else failed state 1ul

let rec reexport_members (input:tape) (state:parser_state) (used:names_used) (remaining:U32.t)
  : Run named_state input (decreases U32.v remaining) =
  let st = skip input state in
  if st.status <> 0ul then { state = st; used }
  else if same input st.offset 125uy then { state = consume input st 125uy; used }
  else if remaining = 0ul then { state = failed st 1ul; used }
  else
    let first = export_identifier input st in
    let tail = skip input first in
    let type_ = keyword input st.offset 4ul 0x74797065uL in
    let type_alias = if type_ then keyword input tail.offset 2ul 0x6173uL else false in
    let second = peek input tail.offset in
    let source, source_end =
      if type_ && not type_alias && G.identifier_start second then tail, export_identifier input tail
      else st, first in
    let after_source = skip input source_end in
    let as_ = keyword input after_source.offset 2ul 0x6173uL in
    let first = if as_ then skip input { after_source with offset = plus after_source.offset 2ul } else source in
    let last = if as_ then export_identifier input first else source_end in
    let named = reserve_export input last used first.offset last.offset in
    let tail = skip input named.state in
    if same input tail.offset 44uy then
      reexport_members input (consume input tail 44uy) named.used (minus remaining 1ul)
    else { named with state = consume input tail 125uy }

let named_reexport (input:tape) (state:parser_state) (used:names_used) : Run named_state input =
  let named = reexport_members input (consume input state 123uy) used 64ul in
  let tail = skip input named.state in
  let from = keyword input tail.offset 4ul 0x66726f6duL in
  let result =
    if from then import_source input { tail with offset = plus tail.offset 4ul }
    else if named.used = used then statement_end input named.state named.state.offset false
    else failed tail 1ul in
  { named with state = result }

type export_prefix = { after_export:parser_state; export_kind:U32.t; direct:bool }

let module_export (input:tape) (state:parser_state) : Read export_prefix input =
  let start = peek input state.offset in
  let exported = if start = 101uy then keyword input state.offset 6ul 0x6578706f7274uL else false in
  if not exported then { after_export = state; export_kind = 0ul; direct = false }
  else
    let tail = skip input { state with offset = plus state.offset 6ul } in
    if keyword input tail.offset 7ul 0x64656661756c74uL then
      { after_export = tail; export_kind = 1ul; direct = false }
    else
      let type_only = keyword input tail.offset 4ul 0x74797065uL in
      let start = if type_only then skip input { tail with offset = plus tail.offset 4ul } else tail in
      let byte = peek input start.offset in
      if byte = 42uy then { after_export = skip input (consume input start 42uy); export_kind = 2ul; direct = false }
      else if byte = 123uy then { after_export = start; export_kind = 3ul; direct = false }
      else { after_export = state; export_kind = 0ul; direct = true }

let default_declaration (input:tape) (state:parser_state) (used:names_used) : Run named_state input =
  let fn = function_start input state.offset in
  if class_keyword input state.offset then
    let start = skip input { state with offset = plus state.offset 5ul } in
    let byte = peek input start.offset in
    let derives = keyword input start.offset 7ul 0x657874656e6473uL in
    let named = if byte = 123uy || byte = 60uy || derives then { state = start; used }
      else bind_at input start 0ul used start.offset in
    { named with state = class_tail input named.state 64ul }
  else if fn.ok then
    let start = skip input { state with offset = plus fn.at 8ul } in
    let byte = peek input start.offset in
    let name = if byte = 40uy || byte = 60uy then { state = start; used }
      else bind_in_namespace input start 0ul 0ul used start.offset ValueName in
    { name with state = function_tail input name.state 64ul (state.offset <> fn.at) NoSuper }
  else
    let value = comparison input state 64ul in
    { state = statement_end input value.parser value.range.G.last false; used }

let rec module_sequence (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t) (exports:names_used)
  : Run parser_state input (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul || st.offset = input.size then st
  else if fuel = 0ul then failed st 1ul
  else if same input st.offset 59uy then
    module_sequence input (consume input st 59uy) used (minus fuel 1ul) exports
  else
    let exported = module_export input st in
    let decl, exports =
      if exported.export_kind = 1ul then
        let name = exported.after_export in
        let end_ = plus name.offset 7ul in
        let reserved = reserve_export input name exports name.offset end_ in
        let body = skip input { reserved.state with offset = end_ } in
        default_declaration input body used, reserved.used
      else if exported.export_kind = 2ul then
        let tail = exported.after_export in
        let source = if keyword input tail.offset 4ul 0x66726f6duL then
          import_source input { tail with offset = plus tail.offset 4ul }
          else failed tail 1ul in
        { state = source; used }, exports
      else if exported.export_kind = 3ul then
        let imported = named_reexport input exported.after_export exports in
        { state = imported.state; used }, imported.used
      else if keyword input st.offset 6ul 0x696d706f7274uL then
        if import_expression_start input st then
          { state = (control_statement input st 64ul false NoJump 0ul 0ul false).state; used }, exports
        else import_declaration input st used, exports
      else
        let first = peek input st.offset in
        let declared =
          if first = 101uy then keyword input st.offset 6ul 0x6578706f7274uL
          else if first = 102uy then keyword input st.offset 8ul 0x66756e6374696f6euL
          else if first = 97uy then (async_function input st.offset).ok
          else if first = 100uy then (ambient_modifier input st.offset).ok
          else if first = 99uy then
            let class_ = class_keyword input st.offset in
            if class_ then true else local_width input st.offset <> 0ul
          else if first = 105uy || first = 116uy then
            let width = type_declaration_width input st.offset in width <> 0ul
          else
            let width = local_width input st.offset in width <> 0ul in
        if declared then module_declaration input st used, exports
        else { state = (control_statement input st 64ul false NoJump 0ul 0ul false).state; used }, exports in
    let reserved = if exported.direct then reserve_direct_exports input decl.state exports used decl.used
      else { state = decl.state; used = exports } in
    module_sequence input reserved.state decl.used (minus fuel 1ul) reserved.used

private let parse_state (input:tape) (st:parser_state) (module_mode:bool) : Run parser_state input =
  if st.status <> 0ul || st.offset = input.size then st
  else
    let first = peek input st.offset in
    let control = statement_kind input st.offset in
    if control <> 0ul then control_sequence input st 64ul input.size false NoJump 0ul 0ul true
    else if first = 118uy then
      if keyword input st.offset 3ul 0x766172uL then
        let initialized = binding input { st with offset = plus st.offset 3ul } 64ul true in
        let st = consume input (skip input initialized) 59uy in
        control_sequence input st 64ul input.size false NoJump 0ul 0ul true
      else failed st 1ul
    else if first <> 99uy && first <> 101uy then failed st 1ul
    else
      let exported = if first = 101uy then keyword input st.offset 6ul 0x6578706f7274uL else false in
      let st =
        if exported then
          if module_mode then skip input { st with offset = plus st.offset 6ul }
          else failed st 1ul
        else st in
      let st = declaration input st in
      let st = skip input st in
      let semicolon = same input st.offset 59uy in
      if semicolon && st.status = 0ul then skip input { st with offset = next st.offset } else st

let initial_state (jsx module_mode:bool) : parser_state = {
  offset = 0ul; count = 0ul; depth = 0ul; status = 0ul; local_names = 0ul;
  await_allowed = module_mode; jsx_allowed = jsx; module_mode; in_allowed = true; for_initializer = false;
  arrow_defaults_allowed = true; binding_mode = NoLocals; super_context = NoSuper
}

// Successful results consume the buffer and expose a bounded candidate count.
let parse (input:tape) (jsx module_mode:bool)
  : Run (r:parser_state{
      (r.status = 0ul ==> r.offset = input.size /\ U32.v r.count <= U32.v input.capacity) /\
      (r.status <> 0ul ==> r.count = 0ul)
    }) input =
  let initial = skip input (initial_state jsx module_mode) in
  let state = parse_state input initial module_mode in
  let state : parser_state =
    if module_mode && (state.status = 1ul || (state.status = 0ul && state.offset <> input.size)) then
      let expanded = module_sequence input initial 0ul input.size 0ul in
      if expanded.status = 1ul then state else expanded
    else state in
  if state.status <> 0ul || state.offset <> input.size then
    { (failed state 1ul) with count = 0ul }
  else if U32.(state.count >^ input.capacity) then
    { (failed state 4ul) with count = 0ul }
  else state

type lexical_conflict = { first_name:G.span; repeated_name:G.span; checked:U32.t }

let no_conflict : lexical_conflict = {
  first_name = { G.first = 0ul; G.last = 0ul };
  repeated_name = { G.first = 0ul; G.last = 0ul };
  checked = 0ul
}

let rec previous_lexical_name (input:tape) (used:names_used) (key:G.span)
  : Run G.span input (decreases U32.v used) =
  if used = 0ul then start_range 0ul
  else
    let index = U32.sub used 1ul in
    let saved = (B.index input.bindings index).span in
    let width = minus key.G.last key.G.first in
    let equal =
      if width = minus saved.G.last saved.G.first then
        same_bytes input key.G.first saved.G.first width
      else false in
    if equal then saved else previous_lexical_name input index key

let lexical_operand (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input state in
  if st.status <> 0ul then st
  else
    let first = peek input st.offset in
    if G.decimal_digit first then from_cursor st (number_end input st.offset)
    else
      let literal =
        if first = 102uy then (if keyword input st.offset 5ul 0x66616c7365uL then 5ul else 0ul)
        else if first = 116uy then (if keyword input st.offset 4ul 0x74727565uL then 4ul else 0ul)
        else if first = 110uy then (if keyword input st.offset 4ul 0x6e756c6cuL then 4ul else 0ul)
        else 0ul in
      if literal = 0ul then from_cursor st (name input st.offset false false)
      else { st with offset = plus st.offset literal }

let lexical_declarator_end (input:tape) (named:parser_state) (allows_empty:bool) : Read parser_state input =
  let st = skip input named in
  let equal = same input st.offset 61uy in
  if not equal then
    if allows_empty then statement_end input named named.offset false else failed st 1ul
  else
    let left = lexical_operand input (consume input st 61uy) in
    let boundary = skip input left in
    let op = operator input boundary.offset true in
    let end_ =
      if op.boundary <> 0ul then lexical_operand input { boundary with offset = plus boundary.offset op.width }
      else left in
    statement_end input end_ end_.offset false

let rec read_lexical_conflict (input:tape) (state:parser_state) (used:names_used)
  (found:lexical_conflict) (fuel:U32.t)
  : Run (r:lexical_conflict{r.repeated_name.G.first <> r.repeated_name.G.last ==> r.checked = input.size}) input
    (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul then no_conflict
  else if st.offset = input.size then { found with checked = st.offset }
  else if fuel = 0ul || used = binding_region_width then no_conflict
  else
    let width = local_width input st.offset in
    if width = 0ul then no_conflict
    else
      let start = skip input { st with offset = plus st.offset width } in
      let key = from_cursor start (name input start.offset false true) in
      let span = { G.first = start.offset; G.last = key.offset } in
      let length = minus key.offset start.offset in
      if key.status <> 0ul || U32.(length >^ 256ul) then no_conflict
      else
        let end_ = lexical_declarator_end input key (width = 3ul) in
        if end_.status <> 0ul then no_conflict
        else
          let previous = previous_lexical_name input used span in
          if previous.G.first = previous.G.last then (
            B.upd input.bindings used { span; namespace = ValueName };
            read_lexical_conflict input end_ (U32.add used 1ul) found (minus fuel 1ul)
          ) else if found.repeated_name.G.first <> found.repeated_name.G.last then no_conflict
          else read_lexical_conflict input end_ used { first_name = previous; repeated_name = span; checked = 0ul }
            (minus fuel 1ul)

let lexical_duplicate (input:tape)
  : Run (r:lexical_conflict{
      r.repeated_name.G.first <> r.repeated_name.G.last ==>
      r.checked = input.size /\
      U32.v r.first_name.G.first < U32.v r.first_name.G.last /\
      U32.v r.first_name.G.last <= U32.v r.repeated_name.G.first /\
      U32.v r.repeated_name.G.first < U32.v r.repeated_name.G.last /\
      U32.v r.repeated_name.G.last <= U32.v input.size
    }) input =
  let conflict = read_lexical_conflict input (initial_state false true) 0ul no_conflict input.size in
  let first = conflict.first_name in
  let second = conflict.repeated_name in
  if U32.(first.G.first <^ first.G.last && first.G.last <=^ second.G.first &&
    second.G.first <^ second.G.last && second.G.last <=^ input.size) then conflict
  else no_conflict
