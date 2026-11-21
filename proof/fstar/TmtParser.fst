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

noeq type tape = {
  source : C.const_buffer U8.t;
  size : n:U32.t { U32.v n == C.length source /\ U32.v n <= 1048576 };
  output : B.buffer G.candidate;
  capacity : n:U32.t { U32.v n == B.length output };
  bindings : b:B.buffer G.span { B.length b == 128 }
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
    else
      let ch = peek input at in
      if U8.(ch >=^ 128uy) then { at; ok = false; newline = false }
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

type names_used = used:U32.t{U32.v used <= 64}
type parser_state = { offset:U32.t; count:U32.t; depth:U32.t; status:U32.t; local_names:names_used }
type parsed = { parser:parser_state; range:G.span; open_angle:bool; outer_or:bool; shortcut:U32.t }

let failed (state:parser_state) (error:U32.t) : parser_state =
  if state.status = 0ul then { state with status = error } else state

let start_range (pos:U32.t) : G.span = { G.first = pos; G.last = pos }
let empty_range (state:parser_state) : parsed = { parser = state; range = start_range state.offset; open_angle = false; outer_or = false; shortcut = 0ul }

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

let simple_escape (input:tape) (at:U32.t) (template:bool) : Read bool input =
  let escape = peek input (next at) in
  let following = peek input (plus at 2ul) in
  escape = 92uy || escape = 34uy || escape = 39uy ||
  escape = 110uy || escape = 114uy || escape = 116uy || escape = 98uy ||
  escape = 102uy || escape = 118uy || (escape = 48uy && not (G.decimal_digit following)) ||
  (template && (escape = 36uy || escape = 96uy))

let rec string_end (input:tape) (at:U32.t) (delimiter:U8.t) (fuel:U32.t)
  : Read cursor input (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ input.size) then { at; ok = false; newline = false }
  else
    let byte = peek input at in
    if byte = delimiter then { at = next at; ok = true; newline = false }
    else
      let breaks = line_break input at in
      if breaks then { at; ok = false; newline = false }
      else if byte = 92uy then
        let valid = simple_escape input at false in
        if valid then string_end input (plus at 2ul) delimiter (minus fuel 1ul)
        else { at; ok = false; newline = false }
      else string_end input (next at) delimiter (minus fuel 1ul)

// Only atoms and quantifiers whose validity needs no regex parser are admitted.
let rec regex_end (input:tape) (at:U32.t) (first can_repeat:bool) (fuel:U32.t)
  : Read cursor input (decreases U32.v fuel) =
  if fuel = 0ul || U32.(at >=^ input.size) then { at; ok = false; newline = false }
  else
    let byte = peek input at in
    if byte = 47uy && not first then { at = next at; ok = true; newline = false }
    else if byte = 92uy then
      let escape = peek input (next at) in
      if escape = 47uy || escape = 92uy || escape = 46uy ||
         escape = 115uy || escape = 83uy || escape = 100uy || escape = 68uy || escape = 119uy || escape = 87uy then
        regex_end input (plus at 2ul) false true (minus fuel 1ul)
      else { at; ok = false; newline = false }
    else if byte = 36uy then
      let closes = same input (next at) 47uy in
      if closes then { at = plus at 2ul; ok = true; newline = false }
      else { at; ok = false; newline = false }
    else if byte = 94uy && first then regex_end input (next at) false false (minus fuel 1ul)
    else if byte = 43uy || byte = 42uy || byte = 63uy then
      if can_repeat then regex_end input (next at) false false (minus fuel 1ul)
      else { at; ok = false; newline = false }
    else if G.identifier_continue byte || byte = 46uy || byte = 45uy || byte = 32uy then
      regex_end input (next at) false true (minus fuel 1ul)
    else { at; ok = false; newline = false }

type precedence = p:U32.t{1 <= U32.v p /\ U32.v p <= 10}
type binary_operator = { strength:precedence; width:U32.t; boundary:U32.t; nullish:bool }

let operator (input:tape) (at:U32.t) : Read binary_operator input =
  let byte = peek input at in
  let follower = peek input (next at) in
  let none = { strength = 1ul; width = 0ul; boundary = 0ul; nullish = false } in
  if byte = 60uy || byte = 62uy then
    if byte = follower then none
    else
      let boundary = S.source_boundary input.source input.size at in
      { strength = 7ul; width = (if follower = 61uy then 2ul else 1ul); boundary; nullish = false }
  else if (byte = 61uy || byte = 33uy) && follower = 61uy then
    let triple = same input (plus at 2ul) 61uy in
    { strength = 6ul; width = (if triple then 3ul else 2ul); boundary = 0ul; nullish = false }
  else if byte = 63uy && follower = 63uy then
    let assignment = same input (plus at 2ul) 61uy in
    if assignment then none else { strength = 1ul; width = 2ul; boundary = 0ul; nullish = true }
  else if follower = 61uy then none
  else if byte = 124uy then
    { strength = (if follower = byte then 1ul else 3ul); width = (if follower = byte then 2ul else 1ul); boundary = 0ul; nullish = false }
  else if byte = 38uy then
    { strength = (if follower = byte then 2ul else 5ul); width = (if follower = byte then 2ul else 1ul); boundary = 0ul; nullish = false }
  else if byte = 94uy then { strength = 4ul; width = 1ul; boundary = 0ul; nullish = false }
  else if (byte = 43uy || byte = 45uy) && follower <> byte then { strength = 8ul; width = 1ul; boundary = 0ul; nullish = false }
  else if (byte = 42uy && follower <> byte) || byte = 47uy || byte = 37uy then
    { strength = 9ul; width = 1ul; boundary = 0ul; nullish = false }
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

type names_base = base:U32.t{base = 0ul \/ base = 64ul}
type named_state = { state:parser_state; used:names_used }

let rec same_bytes (input:tape) (left right length:U32.t)
  : Read bool input (decreases U32.v length) =
  if length = 0ul then true
  else
    let l = peek input left in
    let r = peek input right in
    if l = r then same_bytes input (next left) (next right) (minus length 1ul) else false

let rec name_seen (input:tape) (base:names_base) (floor used:names_used) (pos len:U32.t)
  : Run bool input (decreases U32.v used) =
  if U32.(used <=^ floor) then false
  else
    let previous = U32.sub used 1ul in
    let saved = B.index input.bindings (U32.add base previous) in
    let equal = if len = minus saved.G.last saved.G.first then same_bytes input pos saved.G.first len else false in
    if equal then true else name_seen input base floor previous pos len

let bind_since (input:tape) (st:parser_state) (base:names_base) (floor used:names_used) (pos:U32.t)
  : Run named_state input =
  let end_name = name input pos false true in
  let st = from_cursor st end_name in
  let length = minus st.offset pos in
  if st.status <> 0ul || used = 64ul || U32.(length >^ 256ul) then { state = failed st 1ul; used }
  else if name_seen input base floor used pos length then { state = failed st 1ul; used }
  else (
    B.upd input.bindings (U32.add base used) { G.first = pos; G.last = st.offset };
    { state = st; used = U32.add used 1ul }
  )

let bind_at (input:tape) (st:parser_state) (base:names_base) (used:names_used) (pos:U32.t)
  : Run named_state input = bind_since input st base 0ul used pos

let type_operator (packed:U64.t) : bool =
  packed = 0x6b65796f66uL || packed = 0x696e666572uL ||
  packed = 0x726561646f6e6c79uL || packed = 0x756e69717565uL

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

let rec qualified_type (input:tape) (state:parser_state) (fuel:U32.t)
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
        qualified_type input { property with offset = end_at } (minus fuel 1ul)
  else state

let rec array_type_suffixes (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases U32.v fuel) =
  let after = trivia input state.offset in
  let st = from_cursor state after in
  if st.status <> 0ul then st
  else if same input st.offset 91uy then
    if after.newline || fuel = 0ul then failed st 1ul
    else
      let close = consume input (skip input { st with offset = next st.offset }) 93uy in
      array_type_suffixes input close (minus fuel 1ul)
  else state

let property_name (input:tape) (state:parser_state) : Read cursor input =
  let byte = peek input state.offset in
  if byte = 34uy || byte = 39uy then string_end input (next state.offset) byte input.size
  else if G.identifier_start byte then
    { at = scan_class input state.offset G.Identifier; ok = true; newline = false }
  else { at = state.offset; ok = false; newline = false }

let rec type_reference (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 0; 0]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else
    let named = type_name input st in
    let packed = packed_type input st.offset named.at in
    let undefined = undefined_type input st.offset named.at in
    let primitive = builtin_type packed || undefined in
    let named = from_cursor st named in
    let reference = if primitive then named else qualified_type input named 64ul in
    let after = trivia input reference.offset in
    let tail = from_cursor reference after in
    if type_operator packed then failed tail 1ul
    else if tail.status <> 0ul then tail
    else
      let starts = same input tail.offset 60uy in
      if not starts then reference
      else if after.newline || fuel = 0ul || primitive then failed tail 1ul
      else type_list input { tail with offset = next tail.offset } (minus fuel 1ul) 64ul 62uy false
and type_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (close:U8.t) (allow_empty:bool)
  : Read parser_state input (decreases %[U32.v fuel; 3; U32.v remaining]) =
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
and object_type (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 3; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset 125uy then consume input st 125uy
  else if remaining = 0ul then failed st 1ul
  else
    let is_readonly = keyword input st.offset 8ul 0x726561646f6e6c79uL in
    let key_start =
      if is_readonly then
        let after = skip input { st with offset = plus st.offset 8ul } in
        let next_key = peek input after.offset in
        if G.identifier_start next_key || next_key = 34uy || next_key = 39uy then after else st
      else st in
    let key = property_name input key_start in
    let after = skip input (from_cursor key_start key) in
    let optional = same input after.offset 63uy in
    let after = if optional then skip input (consume input after 63uy) else after in
    let declared = annotation_type input (consume input after 58uy) fuel 64ul in
    let boundary = trivia input declared.offset in
    let end_ = from_cursor declared boundary in
    let next_byte = peek input end_.offset in
    if end_.status <> 0ul then end_
    else if next_byte = 59uy || next_byte = 44uy then
      object_type input (consume input end_ next_byte) fuel (minus remaining 1ul)
    else if next_byte = 125uy then consume input end_ 125uy
    else if boundary.newline then object_type input end_ fuel (minus remaining 1ul)
    else failed end_ 1ul
and type_term (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 1; 0]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else
    let readonly = keyword input st.offset 8ul 0x726561646f6e6c79uL in
    let st = if readonly then skip input { st with offset = plus st.offset 8ul } else st in
    let byte = peek input st.offset in
    let primary =
      if byte = 34uy || byte = 39uy then
        from_cursor st (string_end input (next st.offset) byte input.size)
      else if byte = 91uy || byte = 123uy then
        if fuel = 0ul then failed st 1ul
        else
          let inside = { st with offset = next st.offset } in
          let inner = minus fuel 1ul in
          if byte = 91uy then type_list input inside inner 64ul 93uy true
          else object_type input inside inner input.size
      else type_reference input st fuel in
    let with_arrays = array_type_suffixes input primary 16ul in
    if readonly && byte <> 91uy && primary.offset = with_arrays.offset then failed with_arrays 1ul
    else with_arrays
and annotation_type (input:tape) (state:parser_state) (fuel remaining:U32.t)
  : Read parser_state input (decreases %[U32.v fuel; 2; U32.v remaining]) =
  if remaining = 0ul then failed state 1ul
  else
    let term = type_term input state fuel in
    let st = skip input term in
    let byte = peek input st.offset in
    if st.status <> 0ul then st
    else if byte = 124uy || byte = 38uy then
      annotation_type input { st with offset = next st.offset } fuel (minus remaining 1ul)
    else term

let simple_annotation (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input state in
  let annotation = same input st.offset 58uy in
  if st.status <> 0ul || not annotation then st
  else annotation_type input { st with offset = next st.offset } 16ul 64ul

let function_type_parameter (input:tape) (state:parser_state) : Read parser_state input =
  if state.status <> 0ul then state
  else if same input state.offset 60uy then
    let st = skip input { state with offset = next state.offset } in
    let named = name input st.offset false true in
    let packed = packed_type input st.offset named.at in
    let st = skip input (from_cursor st named) in
    if builtin_type packed || type_operator packed then failed st 1ul
    else consume input st 62uy
  else state

let rec pattern_names (input:tape) (state:parser_state) (floor used:names_used) (fuel:U32.t) (close:U8.t)
  : Run named_state input (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul then { state = st; used }
  else if same input st.offset close then { state = consume input st close; used }
  else if fuel = 0ul then { state = failed st 1ul; used }
  else
    let start =
      if close = 125uy then
        let key = property_name input st in
        let after = skip input (from_cursor st key) in
        if same input after.offset 58uy then skip input (consume input after 58uy)
        else st
      else st in
    let bound = bind_since input start 64ul floor used start.offset in
    let st = skip input bound.state in
    if same input st.offset 44uy then
      pattern_names input (consume input st 44uy) floor bound.used (minus fuel 1ul) close
    else { bound with state = consume input st close }

let parameter_binding (input:tape) (state:parser_state) (floor used:names_used) : Run named_state input =
  let byte = peek input state.offset in
  if byte = 123uy || byte = 91uy then
    let close = if byte = 123uy then 125uy else 93uy in
    pattern_names input (consume input state byte) floor used 64ul close
  else bind_since input state 64ul floor used state.offset

type parameter_list = { names:named_state; patterned:bool }

let rec parameters (input:tape) (state:parser_state) (floor used:names_used) (fuel:U32.t) (patterned:bool)
  : Run parameter_list input (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul then { names = { state = st; used }; patterned }
  else if same input st.offset 41uy then { names = { state = consume input st 41uy; used }; patterned }
  else if fuel = 0ul then { names = { state = failed st 1ul; used }; patterned }
  else
    let byte = peek input st.offset in
    let patterned = patterned || byte = 123uy || byte = 91uy in
    let local = parameter_binding input st floor used in
    let st = skip input (simple_annotation input local.state) in
    if same input st.offset 44uy then
      parameters input (consume input st 44uy) floor local.used (minus fuel 1ul) patterned
    else { names = { state = consume input st 41uy; used = local.used }; patterned }

let arrow_token (input:tape) (state:parser_state) : Read parser_state input =
  if state.status <> 0ul then state
  else
    let tail = trivia input state.offset in
    let st = from_cursor state tail in
    let equal = same input st.offset 61uy in
    let greater = same input (next st.offset) 62uy in
    if not tail.newline && equal && greater then { st with offset = plus st.offset 2ul }
    else failed st 1ul

let arrow_parameters (input:tape) (state:parser_state) : Run parameter_list input =
  let used = state.local_names in
  let missed = { names = { state = failed state 1ul; used }; patterned = false } in
  if state.status <> 0ul then missed
  else
    let byte = peek input state.offset in
    if byte = 40uy then
      let params = parameters input (consume input state 40uy) used used 64ul false in
      let after = trivia input params.names.state.offset in
      let st = from_cursor params.names.state after in
      let colon = same input st.offset 58uy in
      let result =
        if colon && not after.newline then
          annotation_type input (consume input st 58uy) 16ul 64ul
        else params.names.state in
      { params with names = { params.names with state = arrow_token input result } }
    else if G.identifier_start byte then
      let named = name input state.offset false true in
      let body = arrow_token input (from_cursor state named) in
      if body.status <> 0ul then missed
      else
        let param = bind_since input state 64ul used used state.offset in
        { missed with names = { param with state = { param.state with offset = body.offset } } }
    else missed

let function_body (input:tape) (state:parser_state) (patterned:bool) : Read parser_state input =
  if not patterned || state.status <> 0ul then state
  else
    // Patterned parameters have an early error for a strict directive in the prologue.
    let first = skip input (consume input state 123uy) in
    let byte = peek input first.offset in
    if byte = 34uy || byte = 39uy then failed state 1ul else state

let proto_key (input:tape) (first last:U32.t) : Read bool input =
  if minus last first <> 9ul then false
  else
    let start = word input first 8ul 0uL in
    let last = peek input (plus first 8ul) in
    start = 0x5f5f70726f746f5fuL && last = 95uy

let spread_at (input:tape) (at:U32.t) : Read bool input =
  let first = same input at 46uy in
  if not first then false
  else
    let second = same input (next at) 46uy in
    let third = same input (plus at 2ul) 46uy in
    second && third

let statement_kind (input:tape) (at:U32.t) : Read U32.t input =
  let byte = peek input at in
  if byte = 105uy then (if keyword input at 2ul 0x6966uL then 1ul else 0ul)
  else if byte = 119uy then (if keyword input at 5ul 0x7768696c65uL then 2ul else 0ul)
  else if byte = 100uy then (if keyword input at 2ul 0x646fuL then 3ul else 0ul)
  else if byte = 102uy then (if keyword input at 3ul 0x666f72uL then 4ul else 0ul)
  else 0ul

let update (input:tape) (state:parser_state) : Read parser_state input =
  let named = from_cursor state (name input state.offset false true) in
  let before_op = trivia input named.offset in
  let st = from_cursor named before_op in
  let byte = peek input st.offset in
  if before_op.newline || (byte <> 43uy && byte <> 45uy) then failed st 1ul
  else consume input (consume input st byte) byte

let rec assignment_target (input:tape) (state:parser_state) (fuel:U32.t)
  : Read parser_state input (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset 46uy then
    if fuel = 0ul then failed st 1ul
    else
      let member = skip input (consume input st 46uy) in
      let byte = peek input member.offset in
      if member.status <> 0ul || not (G.identifier_start byte) then failed member 1ul
      else
        let end_at = scan_class input member.offset G.Identifier in
        assignment_target input { member with offset = end_at } (minus fuel 1ul)
  else st

let assignment_head (input:tape) (state:parser_state) : Read cursor input =
  let named = from_cursor state (name input state.offset false true) in
  let st = assignment_target input named 64ul in
  let byte = peek input st.offset in
  let follower = peek input (next st.offset) in
  let width =
    if byte = 61uy && follower <> 61uy && follower <> 62uy then 1ul
    else if (byte = 43uy || byte = 45uy) && follower = 61uy then 2ul
    else 0ul in
  if st.status <> 0ul || width = 0ul then { at = state.offset; ok = false; newline = false }
  else { at = plus st.offset width; ok = true; newline = false }

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

let update_statement_end (input:tape) (state:parser_state) : Read parser_state input =
  if state.status <> 0ul then state
  else
    let after = trivia input state.offset in
    let st = from_cursor state after in
    let byte = peek input st.offset in
    if byte = 59uy then consume input st 59uy
    else if st.offset = input.size || byte = 125uy then st
    else if not after.newline then failed st 1ul
    else
      // Insert a semicolon only at a known statement boundary.
      let declaration = local_width input st.offset in
      let control = statement_kind input st.offset in
      let returned = keyword input st.offset 6ul 0x72657475726euL in
      let thrown = keyword input st.offset 5ul 0x7468726f77uL in
      if declaration <> 0ul || control <> 0ul || returned || thrown then st
      else failed st 1ul

let rec atom (input:tape) (current:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 2; 0]) =
  let st = skip input current in
  let start_pos = st.offset in
  if st.status <> 0ul then empty_range st
  else
    let ch = peek input start_pos in
    let prefix = unary_width input start_pos ch in
    let constructor = if ch = 110uy then keyword input start_pos 3ul 0x6e6577uL else false in
    if prefix <> 0ul then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let child = atom input { st with offset = plus start_pos prefix } (minus fuel 1ul) in
        { child with range = { child.range with G.first = start_pos } }
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
            let named = from_cursor target (name input target.offset false false) in
            let args = consume input (skip input named) 40uy in
            expression_list input args inner input.size 41uy
          else
            let inside = { st with offset = next start_pos } in
            if ch = 96uy then template_body input inside inner input.size
            else if ch = 91uy then expression_list input inside inner input.size 93uy
            else object_members input inside inner input.size false in
        postfix input { parser = completed; range = { G.first = start_pos; G.last = completed.offset }; open_angle = false; outer_or = false; shortcut = 0ul }
          fuel input.size false
    else if ch = 40uy then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let inner = comparison input { st with offset = next start_pos; depth } (minus fuel 1ul) in
        let consumed = skip input inner.parser in
        let done_ = consume input consumed 41uy in
        postfix input { parser = done_; range = { G.first = start_pos; G.last = done_.offset }; open_angle = false; outer_or = false; shortcut = 0ul }
          fuel input.size false
    else if G.decimal_digit ch then
      let finish = scan_class input start_pos G.DecimalDigits in
      if ch = 48uy && U32.(finish >^ next start_pos) then empty_range (failed st 1ul)
      else
        let dot = same input finish 46uy in
        let decimal = peek input (next finish) in
        let finish =
          if dot && G.decimal_digit decimal then scan_class input (next finish) G.DecimalDigits
          else finish in
        postfix input { parser = { st with offset = finish }; range = { G.first = start_pos; G.last = finish }; open_angle = false; outer_or = false; shortcut = 0ul }
          fuel input.size true
    else
      let named =
        if ch = 34uy || ch = 39uy then from_cursor st (string_end input (next start_pos) ch input.size)
        else if ch = 47uy then from_cursor st (regex_end input (next start_pos) true false input.size)
        else
          let width =
            if ch = 116uy then
              let is_this = keyword input start_pos 4ul 0x74686973uL in
              if is_this then 4ul else if keyword input start_pos 4ul 0x74727565uL then 4ul else 0ul
            else if ch = 102uy then (if keyword input start_pos 5ul 0x66616c7365uL then 5ul else 0ul)
            else if ch = 110uy then (if keyword input start_pos 4ul 0x6e756c6cuL then 4ul else 0ul)
            else 0ul in
          if width <> 0ul then { st with offset = plus start_pos width }
          else from_cursor st (name input start_pos false false) in
      let base = { parser = named; range = { G.first = start_pos; G.last = named.offset }; open_angle = false; outer_or = false; shortcut = 0ul } in
      postfix input base fuel input.size false
and comparison (input:tape) (current:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 25; 0]) =
  let start = skip input current in
  let arrow = arrow_parameters input start in
  if arrow.names.state.status = 0ul then
    let body = skip input { arrow.names.state with local_names = arrow.names.used } in
    if fuel = 0ul then empty_range (failed body 3ul)
    else
      let depth = minus 65ul fuel in
      let depth = if U32.(depth >^ body.depth) then depth else body.depth in
      let body = { body with depth } in
      let inner = minus fuel 1ul in
      let block = same input body.offset 123uy in
      let result =
        if block then
          let stop = control_block input (function_body input body arrow.patterned) inner true start.local_names arrow.names.used in
          empty_range stop
        else comparison input body inner in
      { result with parser = { result.parser with local_names = start.local_names };
        range = { result.range with G.first = start.offset }; outer_or = false; shortcut = 0ul }
  else
  let lhs = binary input start fuel 1ul in
  let st = lhs.parser in
  if st.status <> 0ul then lhs
  else
    let byte = peek input st.offset in
    let follower = peek input (next st.offset) in
    if byte <> 63uy || follower = 63uy || follower = 46uy then lhs
    else if fuel = 0ul then empty_range (failed st 3ul)
    else
      let inner = minus fuel 1ul in
      let consequent = comparison input { st with offset = next st.offset } inner in
      let alternate = comparison input (consume input consequent.parser 58uy) inner in
      { alternate with range = { alternate.range with G.first = lhs.range.G.first };
        open_angle = lhs.open_angle || consequent.open_angle || alternate.open_angle; outer_or = false; shortcut = 0ul }
and binary (input:tape) (state:parser_state) (fuel:U32.t) (minimum:precedence)
  : Run parsed input (decreases %[U32.v fuel; 24 - U32.v minimum - U32.v minimum; 0]) =
  let lhs = atom input state fuel in
  binary_tail input lhs fuel minimum input.size
and binary_tail (input:tape) (lhs:parsed) (fuel:U32.t) (minimum:precedence) (remaining:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 23 - U32.v minimum - U32.v minimum; U32.v remaining]) =
  let st = skip input lhs.parser in
  if st.status <> 0ul then empty_range st
  else
    let op = operator input st.offset in
    if op.width = 0ul || U32.(op.strength <^ minimum) then { lhs with parser = st }
    else if remaining = 0ul then empty_range (failed st 3ul)
    else if op.strength = 10ul then empty_range (failed st 1ul)
    else if lhs.open_angle && (op.boundary = 3ul || op.boundary = 4ul ||
        op.strength = 3ul || op.strength = 5ul) then empty_range (failed st 1ul)
    else if op.boundary <> 0ul && U32.(st.count >=^ input.capacity) then empty_range (failed st 4ul)
    else
      let count = if op.boundary = 0ul then st.count else next st.count in
      let after = { st with offset = plus st.offset op.width; count } in
      let rhs = binary input after fuel (U32.add op.strength 1ul) in
      if rhs.parser.status <> 0ul then rhs
      else
        let logical = (U32.(op.strength <=^ 2ul) && not op.nullish) || lhs.shortcut = 1ul || rhs.shortcut = 1ul in
        let nullish = op.nullish || lhs.shortcut = 2ul || rhs.shortcut = 2ul in
        if logical && nullish then empty_range (failed rhs.parser 1ul)
        else
          let result = if op.boundary = 0ul then rhs.parser
            else emit_comparison input rhs.parser st.count op.boundary st.offset lhs.range rhs.range in
          let shortcut = if logical then 1ul else if nullish then 2ul else 0ul in
          let combined = { parser = result; range = { lhs.range with G.last = rhs.range.G.last }; shortcut;
            open_angle = lhs.open_angle || rhs.open_angle || op.boundary = 1ul; outer_or = op.strength = 1ul && not op.nullish } in
          binary_tail input combined fuel minimum (minus remaining 1ul)

and postfix (input:tape) (base:parsed) (fuel remaining:U32.t) (decimal:bool)
  : Run parsed input (decreases %[U32.v fuel; 1; U32.v remaining]) =
  if base.parser.status <> 0ul then base
  else
    let after = trivia input base.parser.offset in
    let st = from_cursor base.parser after in
    let byte = peek input st.offset in
    let optional =
      if byte = 63uy then
        let dot = same input (next st.offset) 46uy in
        let digit = peek input (plus st.offset 2ul) in
        dot && not (G.decimal_digit digit)
      else false in
    let bang = if byte = 33uy && not after.newline then
        let equality = same input (next st.offset) 61uy in not equality
      else false in
    if st.status <> 0ul then { base with parser = st }
    // A tagged template continues the left operand even across a line break.
    else if byte = 96uy then empty_range (failed st 1ul)
    else if byte <> 46uy && byte <> 40uy && byte <> 91uy && not bang && not optional then { base with parser = st }
    else if remaining = 0ul then empty_range (failed st 3ul)
    else if decimal && byte = 46uy then empty_range (failed st 1ul)
    else
      let operand = if optional then skip input { st with offset = plus st.offset 2ul } else st in
      let kind = if optional then peek input operand.offset else byte in
      let next_st =
        if kind = 40uy || kind = 91uy then
          if fuel = 0ul then failed st 3ul
          else
            let depth = minus 65ul fuel in
            let depth = if U32.(depth >^ st.depth) then depth else st.depth in
            let inside = { operand with offset = next operand.offset; depth } in
            if kind = 40uy then expression_list input inside (minus fuel 1ul) input.size 41uy
            else
              let index = comparison input inside (minus fuel 1ul) in
              consume input index.parser 93uy
        else if optional || byte = 46uy then
          let property = if optional then operand else skip input { st with offset = next st.offset } in
          let first = peek input property.offset in
          if not (G.identifier_start first) then failed property 1ul
          else { property with offset = scan_class input property.offset G.Identifier }
        else { st with offset = next st.offset } in
      postfix input { base with parser = next_st; range = { base.range with G.last = next_st.offset } }
        fuel (minus remaining 1ul) false
and expression_list (input:tape) (state:parser_state) (fuel remaining:U32.t) (close:U8.t)
  : Run parser_state input (decreases %[U32.v fuel; 26; U32.v remaining]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset close then consume input st close
  else if remaining = 0ul then failed st 3ul
  else
    let spread = spread_at input st.offset in
    let start = if spread then { st with offset = plus st.offset 3ul } else st in
    let arg = comparison input start fuel in
    let st = skip input arg.parser in
    if same input st.offset 44uy then
      // An ungrouped less-than can open a generic call spanning this comma.
      if arg.open_angle then failed st 1ul
      else expression_list input (consume input st 44uy) fuel (minus remaining 1ul) close
    else consume input st close
and object_members (input:tape) (state:parser_state) (fuel remaining:U32.t) (colon_required:bool)
  : Run parser_state input (decreases %[U32.v fuel; 26; U32.v remaining]) =
  let st = skip input state in
  let byte = peek input st.offset in
  if st.status <> 0ul then st
  else if byte = 125uy then consume input st 125uy
  else if remaining = 0ul then failed st 3ul
  else
    let spread = spread_at input st.offset in
    let value =
    if spread && not colon_required then comparison input { st with offset = plus st.offset 3ul } fuel
    else
    let quoted = byte = 34uy || byte = 39uy in
    let key =
      if quoted then string_end input (next st.offset) byte input.size
      else if G.identifier_start byte then { at = scan_class input st.offset G.Identifier; ok = true; newline = false }
      else { at = st.offset; ok = false; newline = false } in
    if not key.ok then empty_range (failed st 1ul)
    else
      let first = if quoted then next st.offset else st.offset in
      let last = if quoted then minus key.at 1ul else key.at in
      let prototype = proto_key input first last in
      let after_key = skip input { st with offset = key.at } in
      let colon = same input after_key.offset 58uy in
      (
        if prototype then empty_range (failed st 1ul)
        else if colon then comparison input (consume input after_key 58uy) fuel
        else if quoted || colon_required then empty_range (failed st 1ul)
        else
          let shorthand = name input st.offset false false in
          if shorthand.ok then empty_range after_key else empty_range (failed st 1ul)
      ) in
    let st = skip input value.parser in
    if same input st.offset 44uy then
      // A colon in the next property rules out a generic argument list across the comma.
      object_members input (consume input st 44uy) fuel (minus remaining 1ul) value.open_angle
    else consume input st 125uy
and template_body (input:tape) (state:parser_state) (fuel remaining:U32.t)
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
          let value = comparison input { state with offset = plus at 2ul } fuel in
          consume input value.parser 125uy
        else if byte = 92uy then
          if simple_escape input at true then { state with offset = plus at 2ul }
          else failed state 1ul
        else { state with offset = next at } in
      template_body input st fuel (minus remaining 1ul)

and condition (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 43; 0]) =
  let st = consume input (skip input state) 40uy in
  let tested = comparison input st fuel in
  consume input (skip input tested.parser) 41uy

and binding (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 43; 0]) =
  let st = skip input state in
  let st = from_cursor st (name input st.offset false true) in
  let st = consume input (skip input st) 61uy in
  let value = comparison input st fuel in
  value.parser

and for_step (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 43; 0]) =
  let simple = update input state in
  if simple.status = 0ul then simple
  else
    let assignment = assignment_head input state in
    if not assignment.ok then simple
    else (comparison input { state with offset = assignment.at } fuel).parser

and for_header (input:tape) (state:parser_state) (top_level:bool) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 45; 0]) =
  let st = consume input (skip input state) 40uy in
  let st = skip input st in
  let declared = keyword input st.offset 3ul 0x6c6574uL in
  let declared = if not declared && top_level then keyword input st.offset 3ul 0x766172uL else declared in
  let st =
    if same input st.offset 59uy then st
    else if declared then
      binding input { st with offset = plus st.offset 3ul } fuel
    else failed st 1ul in
  let st = consume input (skip input st) 59uy in
  let st = skip input st in
  let st = if same input st.offset 59uy then st else (comparison input st fuel).parser in
  let st = consume input (skip input st) 59uy in
  let st = skip input st in
  let st = if same input st.offset 41uy then st else for_step input st fuel in
  consume input (skip input st) 41uy

and return_statement (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 44; 0]) =
  let after = plus state.offset 6ul in
  let body = trivia input after in
  let st = from_cursor state body in
  let byte = peek input st.offset in
  if byte = 59uy || byte = 125uy then statement_end input st after true
  else if body.newline then failed st 1ul
  else
    let value = comparison input st fuel in
    statement_end input value.parser value.range.G.last true

and ordinary_statement (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 45; 0]) =
  if same input state.offset 123uy then failed state 1ul
  else
    let updated = update_statement_end input (update input state) in
    if updated.status = 0ul then updated
    else
      let assignment = assignment_head input state in
      let st = if assignment.ok then { state with offset = assignment.at } else state in
      let value = comparison input st fuel in
      statement_end input value.parser value.range.G.last true

and simple_statement (input:tape) (state:parser_state) (in_function:bool) (fuel:U32.t) : Run parser_state input (decreases %[U32.v fuel; 46; 0]) =
  let byte = peek input state.offset in
  let is_return =
    if byte = 114uy && in_function then keyword input state.offset 6ul 0x72657475726euL else false in
  let is_throw = if byte = 116uy then keyword input state.offset 5ul 0x7468726f77uL else false in
  if is_return then return_statement input state fuel
  else if is_throw then
    let body = trivia input (plus state.offset 5ul) in
    let st = from_cursor state body in
    if body.newline then failed st 1ul
    else
      let value = comparison input st fuel in
      statement_end input value.parser value.range.G.last true
  else if byte = 59uy then consume input state 59uy
  else ordinary_statement input state fuel

and local_declaration (input:tape) (state:parser_state) (width:U32.t) (floor used:names_used) (fuel:U32.t)
  : Run named_state input (decreases %[U32.v fuel; 45; 0]) =
  let start = skip input { state with offset = plus state.offset width } in
  let decl = bind_since input start 64ul floor used start.offset in
  let st = skip input (simple_annotation input { decl.state with local_names = decl.used }) in
  let value = comparison input (consume input st 61uy) fuel in
  { decl with state = statement_end input value.parser value.range.G.last true }

and control_block (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (floor used:names_used)
  : Run parser_state input (decreases %[U32.v fuel; 49; 0]) =
  let st = consume input (skip input state) 123uy in
  let st = control_sequence input { st with local_names = used } fuel input.size in_function floor used false in
  consume input { st with local_names = state.local_names } 125uy
and control_sequence (input:tape) (state:parser_state) (fuel remaining:U32.t) (in_function:bool)
  (floor used:names_used) (allow_var:bool)
  : Run parser_state input (decreases %[U32.v fuel; 48; U32.v remaining]) =
  let st = skip input { state with local_names = used } in
  let closed = same input st.offset 125uy in
  if st.status <> 0ul || st.offset = input.size || closed then st
  else if remaining = 0ul then failed st 1ul
  else
    let width = if in_function then local_width input st.offset else 0ul in
    let next_statement = if width <> 0ul then local_declaration input st width floor used fuel
      else { state = control_statement input st fuel in_function used allow_var; used } in
    control_sequence input next_statement.state fuel (minus remaining 1ul) in_function floor next_statement.used allow_var
and control_statement (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (used:names_used) (allow_var:bool)
  : Run parser_state input (decreases %[U32.v fuel; 47; 0]) =
  let kind = statement_kind input state.offset in
  if state.status <> 0ul then state
  else if kind = 0ul then simple_statement input state in_function fuel
  else if fuel = 0ul then failed state 3ul
  else
    let inner = minus fuel 1ul in
    let depth = minus 65ul fuel in
    let state = if U32.(depth >^ state.depth) then { state with depth } else state in
    if kind = 1ul || kind = 2ul then
      let width = if kind = 1ul then 2ul else 5ul in
      let tested = condition input { state with offset = plus state.offset width } fuel in
      let st = skip input (control_body input tested inner in_function used) in
      let has_else = if kind = 1ul then keyword input st.offset 4ul 0x656c7365uL else false in
      if has_else then
        control_body input { st with offset = plus st.offset 4ul } inner in_function used
      else st
    else if kind = 3ul then
      let st = skip input (control_body input { state with offset = plus state.offset 2ul } inner in_function used) in
      let tested = keyword input st.offset 5ul 0x7768696c65uL in
      if not tested then failed st 1ul
      else
        let st = skip input (condition input { st with offset = plus st.offset 5ul } fuel) in
        if same input st.offset 59uy then consume input st 59uy else st
    else
      let tested = for_header input { state with offset = plus state.offset 3ul } allow_var fuel in
      control_body input tested inner in_function used
and control_body (input:tape) (state:parser_state) (fuel:U32.t) (in_function:bool) (used:names_used)
  : Run parser_state input (decreases %[U32.v fuel; 50; 0]) =
  let st = skip input state in
  if st.status <> 0ul then st
  else if same input st.offset 123uy then control_block input st fuel in_function used used
  else simple_statement input st in_function fuel

let tag_space (input:tape) (state:parser_state) : Read parser_state input =
  let at = scan_class input state.offset G.Space in
  { state with offset = at }

let rec quote_end (input:tape) (at:U32.t) (delimiter:U8.t) (fuel:U32.t) : Read U32.t input (decreases U32.v fuel) =
  if U32.(at >=^ input.size) || fuel = 0ul then at
  else
    let byte = peek input at in
    if byte = delimiter then at else quote_end input (next at) delimiter (minus fuel 1ul)

let attr (input:tape) (current:parser_state) : Run parser_state input =
  let named = name input current.offset true false in
  let st = from_cursor current named in
  let st = tag_space input st in
  let st = consume input st 61uy in
  let st = tag_space input st in
  if st.status <> 0ul then st
  else
    let byte = peek input st.offset in
    if byte = 34uy || byte = 39uy then
      let pos = quote_end input (next st.offset) byte input.size in
      consume input { st with offset = pos } byte
    else
      let st = consume input st 123uy in
      let value = comparison input st 64ul in
      let st = skip input value.parser in
      // The broader parser supplies the focused rewrite for a direct disabled disjunction.
      let disabled = if value.outer_or && minus named.at current.offset = 8ul then
          let attr_name = word input current.offset 8ul 0uL in attr_name = 0x64697361626c6564uL
        else false in
      if disabled then failed st 1ul else consume input st 125uy

let rec element_tail (input:tape) (state:parser_state) (fuel:U32.t) : Run parser_state input (decreases U32.v fuel) =
  if state.status <> 0ul then state
  else if fuel = 0ul then failed state 1ul
  else
    let st = tag_space input state in
    let closing = same input st.offset 47uy in
    if closing then consume input { st with offset = next st.offset } 62uy
    else if st.offset = state.offset then failed st 1ul
    else
      let following = attr input st in
      element_tail input following (minus fuel 1ul)

let body (input:tape) (state:parser_state) (jsx:bool) : Run parser_state input =
  let st = skip input state in
  let opener = same input st.offset 60uy in
  if st.status = 0ul && jsx && opener then
    let named = name input (next st.offset) true false in
    element_tail input (from_cursor st named) input.size
  else
    let e = comparison input st 64ul in
    e.parser

let arrow_tail (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input { state with offset = next state.offset } in
  let has_type = keyword input st.offset 6ul 0x6e756d626572uL in
  if st.status <> 0ul || not has_type then failed st 1ul
  else
    let st = skip input { st with offset = plus st.offset 6ul } in
    let st = consume input st 41uy in
    let trivia_ = trivia input st.offset in
    let st = from_cursor st trivia_ in
    if trivia_.newline then failed st 1ul
    else
      let st = consume input st 61uy in
      consume input st 62uy

let initializer (input:tape) (state:parser_state) (jsx:bool) : Run parser_state input =
  let st = skip input state in
  let grouped = same input st.offset 40uy in
  if st.status <> 0ul then st
  else if grouped then
    let inner = trivia input (next st.offset) in
    let param = name input inner.at false true in
    let t = trivia input param.at in
    let colon = same input t.at 58uy in
    if inner.ok && param.ok && t.ok && colon then
      let after = skip input (arrow_tail input { st with offset = t.at }) in
      let tag = same input after.offset 60uy in
      if after.status = 0ul && tag && jsx then body input after jsx
      else body input st jsx
    else body input st jsx
  else body input st jsx

let declaration (input:tape) (state:parser_state) (jsx:bool) : Run parser_state input =
  let has_const = keyword input state.offset 5ul 0x636f6e7374uL in
  if state.status <> 0ul || not has_const then failed state 1ul
  else
    let st = skip input { state with offset = plus state.offset 5ul } in
    let named = name input st.offset false true in
    let st = skip input (from_cursor st named) in
    let st = consume input st 61uy in
    initializer input st jsx

let import_source (input:tape) (state:parser_state) : Read parser_state input =
  let st = skip input state in
  let delimiter = peek input st.offset in
  if st.status <> 0ul || (delimiter <> 34uy && delimiter <> 39uy) then failed st 1ul
  else
    let literal = string_end input (next st.offset) delimiter input.size in
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
    let members =
      if byte = 123uy || byte = 42uy then import_bindings input st used true
      else if keyword input st.offset 4ul 0x74797065uL then
        import_bindings input { st with offset = plus st.offset 4ul } used false
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

let async_function (input:tape) (start:U32.t) : Read cursor input =
  if keyword input start 5ul 0x6173796e63uL then
    let after = trivia input (plus start 5ul) in
    let is_function = keyword input after.at 8ul 0x66756e6374696f6euL in
    if after.ok && not after.newline && is_function then after
    else { at = start; ok = false; newline = false }
  else { at = start; ok = false; newline = false }

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

let module_declaration (input:tape) (state:parser_state) (used:names_used) : Run named_state input =
  let st =
    if keyword input state.offset 6ul 0x6578706f7274uL then skip input { state with offset = plus state.offset 6ul }
    else state in
  let async_ = async_function input st.offset in
  let st = if async_.ok then { st with offset = async_.at } else st in
  let width =
    if keyword input st.offset 8ul 0x66756e6374696f6euL then 8ul
    else
      let declared = type_declaration_width input st.offset in
      if declared <> 0ul then declared else local_width input st.offset in
  if width = 0ul then { state = failed st 1ul; used }
  else
    let start = skip input { st with offset = plus st.offset width } in
    let decl = bind_at input start 0ul used start.offset in
    let st = skip input decl.state in
    let result =
      if width = 4ul || width = 9ul then
        let packed = packed_type input start.offset decl.state.offset in
        let undefined = undefined_type input start.offset decl.state.offset in
        if builtin_type packed || undefined || type_operator packed then failed st 1ul
        else
          let st = skip input (function_type_parameter input st) in
          if width = 9ul then object_type input (consume input st 123uy) 15ul input.size
          else
            let alias = annotation_type input (consume input st 61uy) 16ul 64ul in
            statement_end input alias alias.offset false
      else if width = 8ul then
        let st = skip input (function_type_parameter input st) in
        let params = parameters input (consume input st 40uy) 0ul 0ul 64ul false in
        let st = skip input (simple_annotation input params.names.state) in
        control_block input (function_body input st params.patterned) 64ul true 0ul params.names.used
      else
        let st = skip input (simple_annotation input st) in
        let value = comparison input (consume input st 61uy) 64ul in
        statement_end input value.parser value.range.G.last false in
    { decl with state = result }

let rec module_sequence (input:tape) (state:parser_state) (used:names_used) (fuel:U32.t)
  : Run parser_state input (decreases U32.v fuel) =
  let st = skip input state in
  if st.status <> 0ul || st.offset = input.size then st
  else if fuel = 0ul then failed st 1ul
  else if same input st.offset 59uy then
    module_sequence input (consume input st 59uy) used (minus fuel 1ul)
  else
    let decl =
      if keyword input st.offset 6ul 0x696d706f7274uL then import_declaration input st used
      else
        let first = peek input st.offset in
        let declared =
          if first = 101uy then keyword input st.offset 6ul 0x6578706f7274uL
          else if first = 102uy then keyword input st.offset 8ul 0x66756e6374696f6euL
          else if first = 97uy then (async_function input st.offset).ok
          else if first = 105uy || first = 116uy then
            let width = type_declaration_width input st.offset in width <> 0ul
          else
            let width = local_width input st.offset in width <> 0ul in
        if declared then module_declaration input st used
        else { state = control_statement input st 64ul false 0ul false; used } in
    module_sequence input decl.state decl.used (minus fuel 1ul)

private let parse_state (input:tape) (st:parser_state) (jsx module_mode:bool) : Run parser_state input =
  if st.status <> 0ul || st.offset = input.size then st
  else
    let first = peek input st.offset in
    let control = statement_kind input st.offset in
    if control <> 0ul then control_sequence input st 64ul input.size false 0ul 0ul true
    else if first = 118uy then
      if keyword input st.offset 3ul 0x766172uL then
        let initialized = binding input { st with offset = plus st.offset 3ul } 64ul in
        let st = consume input (skip input initialized) 59uy in
        control_sequence input st 64ul input.size false 0ul 0ul true
      else failed st 1ul
    else if first <> 99uy && first <> 101uy then failed st 1ul
    else
      let exported = if first = 101uy then keyword input st.offset 6ul 0x6578706f7274uL else false in
      let st =
        if exported then
          if module_mode then skip input { st with offset = plus st.offset 6ul }
          else failed st 1ul
        else st in
      let st = declaration input st jsx in
      let st = skip input st in
      let semicolon = same input st.offset 59uy in
      if semicolon && st.status = 0ul then skip input { st with offset = next st.offset } else st

// Successful results consume the buffer and expose a bounded candidate count.
let parse (input:tape) (jsx module_mode:bool)
  : Run (r:parser_state{
      (r.status = 0ul ==> r.offset = input.size /\ U32.v r.count <= U32.v input.capacity) /\
      (r.status <> 0ul ==> r.count = 0ul)
    }) input =
  let initial = skip input { offset = 0ul; count = 0ul; depth = 0ul; status = 0ul; local_names = 0ul } in
  let state = parse_state input initial jsx module_mode in
  let state : parser_state =
    if module_mode && (state.status = 1ul || (state.status = 0ul && state.offset <> input.size)) then
      let expanded = module_sequence input initial 0ul input.size in
      if expanded.status = 1ul then state else expanded
    else state in
  if state.status <> 0ul || state.offset <> input.size then
    { (failed state 1ul) with count = 0ul }
  else if U32.(state.count >^ input.capacity) then
    { (failed state 4ul) with count = 0ul }
  else state
