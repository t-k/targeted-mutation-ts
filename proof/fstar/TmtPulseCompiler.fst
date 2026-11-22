module TmtPulseCompiler
#lang-pulse

open Pulse.Lib.Pervasives
open Pulse.Lib.Array
module U8 = FStar.UInt8
module U32 = FStar.UInt32
module U64 = FStar.UInt64
module Seq = FStar.Seq
module Size = FStar.SizeT
module G = TmtGrammar
module P = TmtPulseParser
module M = TmtPulseMemory

type annotation = { valid:bool; offset:U32.t; erased:G.span }
type edit_plan = { valid:bool; binding:G.span; parameter:G.span; result_type:G.span }

let empty_span : G.span = { first = 0ul; last = 0ul }
let declined () : edit_plan = { valid = false; binding = empty_span; parameter = empty_span; result_type = empty_span }

let make_annotation (valid:bool) (offset:U32.t) (erased:G.span) : annotation = { valid; offset; erased }
let make_plan (binding parameter result_type:G.span) : edit_plan = { valid = true; binding; parameter; result_type }
let plain_cursor (at:U32.t) (ok:bool) : P.cursor = { P.at = at; ok; newline = false }
let range (first last:U32.t) : G.span = { G.first = first; G.last = last }

let primitive_type (word:U64.t) : bool =
  word = 0x6e756d626572uL || word = 0x737472696e67uL || word = 0x626f6f6c65616euL ||
  word = 0x626967696e74uL || word = 0x756e6b6e6f776euL || word = 0x6e65766572uL ||
  word = 0x616e79uL || word = 0x6f626a656374uL || word = 0x73796d626f6cuL ||
  word = 0x766f6964uL || word = 0x6e756c6cuL

fn spaces (input:M.tape) (#frame:slprop) (start:U32.t)
  requires M.input_ready input ** frame
  returns stop:U32.t
  ensures M.input_ready input ** frame
{
  let mut cursor = start;
  while (let at = !cursor;
    if (U32.lt at input.size) {
      let byte = M.peek input #frame at;
      byte = 32uy
    } else { false })
  invariant exists* (at:U32.t). pts_to cursor at ** M.input_ready input ** frame
  decreases (U32.v input.size - U32.v !cursor)
  {
    cursor := P.next !cursor;
  };
  !cursor
}

fn annotation_after (input:M.tape) (#frame:slprop) (start:U32.t)
  requires M.input_ready input ** frame
  returns result:annotation
  ensures M.input_ready input ** frame
{
  let token = P.trivia input #frame start;
  let has_colon = P.same input #frame token.at 58uy;
  if (not token.ok) {
    make_annotation false start empty_span
  } else if (not has_colon) {
    make_annotation true start empty_span
  } else {
    let type_start = spaces input #frame (P.next token.at);
    let finish = P.scan_class input #frame type_start G.Identifier;
    let width = P.minus finish type_start;
    let valid = if (U32.gt width 8ul) { false } else {
      let word = P.word input #frame type_start width 0uL;
      primitive_type word
    };
    make_annotation valid finish (range token.at finish)
  }
}

fn atom (input:M.tape) (#frame:slprop) (start:U32.t)
  requires M.input_ready input ** frame
  returns stop:P.cursor
  ensures M.input_ready input ** frame
{
  let token = P.trivia input #frame start;
  let first = M.peek input #frame token.at;
  if (not token.ok) { token }
  else if (G.decimal_digit first) {
    let at = P.scan_class input #frame token.at G.DecimalDigits;
    let ok = first <> 48uy || at = P.next token.at;
    plain_cursor at ok
  } else {
    let literal = if (first = 116uy) {
      P.keyword input #frame token.at 4ul 0x74727565uL
    } else if (first = 102uy) {
      P.keyword input #frame token.at 5ul 0x66616c7365uL
    } else if (first = 110uy) {
      P.keyword input #frame token.at 4ul 0x6e756c6cuL
    } else { false };
    if (literal) {
      plain_cursor (P.plus token.at (if first = 102uy then 5ul else 4ul)) true
    } else { P.name input #frame token.at false false }
  }
}

fn complete (input:M.tape) (#frame:slprop) (end_:P.cursor)
  requires M.input_ready input ** frame
  returns ok:bool
  ensures M.input_ready input ** frame
{
  if (not end_.ok) { false } else {
    let tail = P.trivia input #frame end_.at;
    let semicolon = P.same input #frame tail.at 59uy;
    let eof = if (semicolon && tail.ok) { P.trivia input #frame (P.next tail.at) } else { tail };
    eof.ok && eof.at = input.size
  }
}

fn expression_end (input:M.tape) (#frame:slprop) (start:U32.t)
  requires M.input_ready input ** frame
  returns end_:P.cursor
  ensures M.input_ready input ** frame
{
  let left = atom input #frame start;
  if (not left.ok) { left } else {
    let operator = P.trivia input #frame left.at;
    let first = M.peek input #frame operator.at;
    let second = M.peek input #frame (P.next operator.at);
    let kind = G.boundary first second;
    if (operator.ok && kind <> 0ul) {
      atom input #frame (P.operator_end operator.at kind)
    } else { left }
  }
}

fn arrow_plan (input:M.tape) (#frame:slprop) (binding:G.span) (start:U32.t)
  requires M.input_ready input ** frame
  returns plan:edit_plan
  ensures M.input_ready input ** frame
{
  let head = P.trivia input #frame start;
  let name = P.name input #frame head.at false true;
  if (not (head.ok && name.ok)) { declined () } else {
    let parameter = annotation_after input #frame name.at;
    let close = P.trivia input #frame parameter.offset;
    let closes = P.same input #frame close.at 41uy;
    if (not (parameter.valid && close.ok && closes)) { declined () } else {
      let arrow_start = P.next close.at;
      let after_close = P.trivia input #frame arrow_start;
      let result_type = annotation_after input #frame arrow_start;
      let arrow = P.trivia input #frame result_type.offset;
      let equal = P.same input #frame arrow.at 61uy;
      let greater = P.same input #frame (P.next arrow.at) 62uy;
      if (not (result_type.valid && after_close.ok && not after_close.newline &&
          arrow.ok && not arrow.newline && equal && greater)) { declined () } else {
        let tail = expression_end input #frame (P.plus arrow.at 2ul);
        let all = complete input #frame tail;
        if (all) {
          make_plan binding parameter.erased result_type.erased
        } else { declined () }
      }
    }
  }
}

fn read_plan (input:M.tape) (#frame:slprop)
  requires M.input_ready input ** frame
  returns plan:edit_plan
  ensures M.input_ready input ** frame
{
  let head = P.trivia input #frame 0ul;
  let exported = P.keyword input #frame head.at 6ul 0x6578706f7274uL;
  if (not (head.ok && exported)) { declined () } else {
    let kind = P.trivia input #frame (P.plus head.at 6ul);
    let constant = P.keyword input #frame kind.at 5ul 0x636f6e7374uL;
    if (not (kind.ok && constant)) { declined () } else {
      let name_start = P.trivia input #frame (P.plus kind.at 5ul);
      let name = P.name input #frame name_start.at false true;
      let binding = annotation_after input #frame name.at;
      let equal = P.trivia input #frame binding.offset;
      let assigns = P.same input #frame equal.at 61uy;
      if (not (name_start.ok && name.ok && binding.valid && equal.ok && assigns)) { declined () } else {
        let init = P.trivia input #frame (P.next equal.at);
        let arrow = P.same input #frame init.at 40uy;
        if (not init.ok) { declined () }
        else if (arrow) { arrow_plan input #frame binding.erased (P.next init.at) }
        else {
          let end_ = expression_end input #frame init.at;
          let all = complete input #frame end_;
          if (all) { make_plan binding.erased empty_span empty_span } else { declined () }
        }
      }
    }
  }
}

let blanked (before after:Seq.seq U8.t) (start stop:nat) : prop =
  Seq.length before == Seq.length after /\
  (forall (i:nat). i < Seq.length before ==>
    Seq.index after i == (if start <= i && i < stop then 32uy else Seq.index before i))

let extend_blank (before current:Seq.seq U8.t) (first next:nat)
  : Lemma
    (requires first <= next /\ next < Seq.length current /\ blanked before current first next)
    (ensures blanked before (Seq.upd current next 32uy) first (next + 1))
  = Seq.lemma_len_upd next 32uy current;
    Classical.forall_intro (fun (i:nat) ->
      if i < Seq.length before then
        if i = next then Seq.lemma_index_upd1 current next 32uy
        else Seq.lemma_index_upd2 current next 32uy i)

fn blank (output:array U8.t) (#before:FStar.Ghost.erased (Seq.seq U8.t))
  (size:U32.t{U32.v size == Seq.length before})
  (first:U32.t) (last:U32.t{U32.v first <= U32.v last /\ U32.v last <= U32.v size})
  requires pts_to output before
  ensures exists* after. pts_to output after ** pure (blanked before after (U32.v first) (U32.v last))
{
  pts_to_len output;
  let mut index = first;
  while (U32.lt !index last)
  invariant exists* (at:U32.t) current. pts_to index at ** pts_to output current **
    pure (U32.v first <= U32.v at /\ U32.v at <= U32.v last /\ blanked before current (U32.v first) (U32.v at))
  decreases (U32.v last - U32.v !index)
  {
    let at = !index;
    with current. assert (pts_to output current);
    extend_blank before current (U32.v first) (U32.v at);
    output.(Size.uint32_to_sizet at) <- 32uy;
    index := U32.add at 1ul;
  };
  ()
}

fn blank_range (output:array U8.t) (#before:FStar.Ghost.erased (Seq.seq U8.t))
  (size:U32.t{U32.v size == Seq.length before}) (first last:U32.t)
  requires pts_to output before
  returns ok:bool
  ensures exists* after. pts_to output after ** pure (
    (if ok then blanked before after (U32.v first) (U32.v last) else before == after))
{
  if (U32.lte first last && U32.lte last size) {
    blank output size first last;
    true
  } else { false }
}

open TmtPulseMemory

let type_declaration (input:tape) (state:P.parser_state) (used:P.names_used) (width:U32.t)
  : Tot (stt P.named_state (heap input) (fun _ -> heap input)) =
  let! start = (fun () -> P.skip input { state with offset = P.plus state.offset width }) in
  let namespace = if width = 9ul then InterfaceName else TypeName in
  let! named = (fun () -> P.bind_in_namespace input start 0ul 0ul used start.offset namespace) in
  let! valid = (fun () -> P.admissible_type_binding input start.offset named.state.offset) in
  let! tail = (fun () -> if not valid then ret input (P.failed named.state 1ul)
    else if width = 9ul then P.interface_tail input named.state
    else P.type_alias_tail input named.state false) in
  ret input { named with state = tail }

let rec type_only_statements (input:tape) (state:P.parser_state) (used:P.names_used) (module_seen:bool) (fuel:U32.t)
  : Tot (stt bool (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! st = (fun () -> P.skip input state) in
  if st.status <> 0ul then ret input false
  else if st.offset = input.size then ret input module_seen
  else if fuel = 0ul then ret input false
  else
    let! imported = (fun () -> P.keyword input st.offset 6ul 0x696d706f7274uL) in
    if imported then
      let! kind = (fun () -> P.skip input { st with offset = P.plus st.offset 6ul }) in
      let! typed = (fun () -> P.keyword input kind.offset 4ul 0x74797065uL) in
      let! first = (fun () -> P.skip input { kind with offset = P.plus kind.offset 4ul }) in
      let! value_import = (fun () -> P.keyword input first.offset 4ul 0x66726f6duL) in
      let! byte = (fun () -> peek input first.offset) in
      if not typed || value_import || first.status <> 0ul ||
        (not (G.identifier_start byte) && byte <> 123uy && byte <> 42uy) then ret input false
      else
        let! next = (fun () -> P.import_declaration input st used) in
        type_only_statements input next.state next.used true (P.minus fuel 1ul)
    else
      let! exported = (fun () -> P.keyword input st.offset 6ul 0x6578706f7274uL) in
      let! start = (fun () -> if exported then P.skip input { st with offset = P.plus st.offset 6ul } else ret input st) in
      let! empty = (fun () -> P.same input start.offset 59uy) in
      let! prefix = (fun () -> P.word input start.offset 8ul 0uL) in
      let! interface = (fun () -> if prefix = 0x696e746572666163uL then
        P.keyword input (P.plus start.offset 8ul) 1ul 0x65uL else ret input false) in
      let! alias = (fun () -> P.keyword input start.offset 4ul 0x74797065uL) in
      if empty && not exported then
        type_only_statements input { start with offset = P.next start.offset } used module_seen (P.minus fuel 1ul)
      else if not (interface || alias) then ret input false
      else
        let! next = (fun () -> type_declaration input start used (if interface then 9ul else 4ul)) in
        type_only_statements input next.state next.used (module_seen || exported) (P.minus fuel 1ul)

fn type_only_module (input:tape)
  requires heap input
  returns accepted:bool
  ensures heap input
{
  type_only_statements input (P.initial_state false true P.primary_locals) 0ul false 512ul
}
