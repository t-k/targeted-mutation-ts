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
  capacity : n:U32.t { U32.v n == B.length output }
}

let live (input:tape) h = C.live h input.source /\ B.live h input.output

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
  else if ch = 226uy then
    let second = peek input (plus at 1ul) in
    let third = peek input (plus at 2ul) in
    second = 128uy && (third = 168uy || third = 169uy)
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

type parser_state = { offset:U32.t; count:U32.t; depth:U32.t; status:U32.t }
type parsed = { parser:parser_state; range:G.span }

let failed (state:parser_state) (error:U32.t) : parser_state =
  if state.status = 0ul then { state with status = error } else state

let start_range (pos:U32.t) : G.span = { G.first = pos; G.last = pos }
let empty_range (state:parser_state) : parsed = { parser = state; range = start_range state.offset }

let consume (input:tape) (state:parser_state) (byte:U8.t) : Read parser_state input =
  if state.status <> 0ul then state
  else
    let ok = same input state.offset byte in
    if ok then { state with offset = next state.offset } else failed state 1ul

let from_cursor (state:parser_state) (read:cursor) : parser_state =
  if state.status <> 0ul then state
  else if read.ok then { state with offset = read.at } else failed state 1ul

let skip (input:tape) (state:parser_state) : Read parser_state input =
  let next = trivia input state.offset in
  from_cursor state next

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

let rec atom (input:tape) (current:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 0]) =
  let st = skip input current in
  let start_pos = st.offset in
  if st.status <> 0ul then empty_range st
  else
    let ch = peek input start_pos in
    if ch = 40uy then
      if fuel = 0ul then empty_range (failed st 3ul)
      else
        let depth = minus 65ul fuel in
        let depth = if U32.(depth >^ st.depth) then depth else st.depth in
        let inner = comparison input { st with offset = next start_pos; depth } (minus fuel 1ul) in
        let consumed = skip input inner.parser in
        let done_ = consume input consumed 41uy in
        { parser = done_; range = { G.first = start_pos; G.last = done_.offset } }
    else if G.decimal_digit ch then
      let finish = scan_class input start_pos G.DecimalDigits in
      if ch = 48uy && U32.(finish >^ next start_pos) then empty_range (failed st 1ul)
      else { parser = { st with offset = finish }; range = { G.first = start_pos; G.last = finish } }
    else
      let name_ = name input start_pos false false in
      let st = from_cursor st name_ in
      { parser = st; range = { G.first = start_pos; G.last = st.offset } }
and comparison (input:tape) (current:parser_state) (fuel:U32.t)
  : Run parsed input (decreases %[U32.v fuel; 1]) =
  let lhs = atom input current fuel in
  let st = skip input lhs.parser in
  if st.status <> 0ul then empty_range st
  else
    let op = S.source_boundary input.source input.size st.offset in
    if op = 0ul then { lhs with parser = st }
    else if U32.(st.count >=^ input.capacity) then empty_range (failed st 4ul)
    else
      let start_op = st.offset in
      let end_op = operator_end start_op op in
      let rhs = atom input { st with offset = end_op; count = next st.count } fuel in
      if rhs.parser.status <> 0ul then rhs
      else
        let done_ = emit_comparison input rhs.parser st.count op start_op lhs.range rhs.range in
        { parser = done_; range = { G.first = lhs.range.G.first; G.last = rhs.range.G.last } }

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
      consume input st 125uy

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
      let after = arrow_tail input { st with offset = t.at } in
      body input after jsx
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

private let parse_state (input:tape) (jsx module_mode:bool) : Run parser_state input =
  let st = skip input { offset = 0ul; count = 0ul; depth = 0ul; status = 0ul } in
  if st.status <> 0ul || st.offset = input.size then st
  else
    let exported = keyword input st.offset 6ul 0x6578706f7274uL in
    let st =
      if exported then
        if module_mode then skip input { st with offset = plus st.offset 6ul }
        else failed st 1ul
      else st in
    let st = declaration input st jsx in
    let st = skip input st in
    let semicolon = same input st.offset 59uy in
    let st = if semicolon && st.status = 0ul then skip input { st with offset = next st.offset } else st in
    st

// Successful results consume the buffer and expose a bounded candidate count.
let parse (input:tape) (jsx module_mode:bool)
  : Run (r:parser_state{
      (r.status = 0ul ==> r.offset = input.size /\ U32.v r.count <= U32.v input.capacity) /\
      (r.status <> 0ul ==> r.count = 0ul)
    }) input =
  let state = parse_state input jsx module_mode in
  if state.status <> 0ul || state.offset <> input.size then
    { (failed state 1ul) with count = 0ul }
  else if U32.(state.count >^ input.capacity) then
    { (failed state 4ul) with count = 0ul }
  else state
