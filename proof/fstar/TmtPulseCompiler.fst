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
type edit_plan = {
  valid:bool; stop:U32.t; name_span:G.span;
  binding:G.span; parameter:G.span; result_type:G.span
}

let empty_span : G.span = { first = 0ul; last = 0ul }
let declined () : edit_plan = {
  valid = false; stop = 0ul; name_span = empty_span;
  binding = empty_span; parameter = empty_span; result_type = empty_span
}

let make_annotation (valid:bool) (offset:U32.t) (erased:G.span) : annotation = { valid; offset; erased }
let make_plan (stop:U32.t) (name_span binding parameter result_type:G.span) : edit_plan =
  { valid = true; stop; name_span; binding; parameter; result_type }
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

fn declaration_end (input:M.tape) (#frame:slprop) (end_:P.cursor)
  requires M.input_ready input ** frame
  returns finish:P.cursor
  ensures M.input_ready input ** frame
{
  if (not end_.ok) { end_ } else {
    let tail = P.trivia input #frame end_.at;
    let semicolon = P.same input #frame tail.at 59uy;
    if (semicolon && tail.ok) { P.trivia input #frame (P.next tail.at) }
    else { plain_cursor tail.at (tail.ok && tail.at = input.size) }
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

fn arrow_plan (input:M.tape) (#frame:slprop) (name_span binding:G.span) (start:U32.t)
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
        let finish = declaration_end input #frame tail;
        if (finish.ok) {
          make_plan finish.at name_span binding parameter.erased result_type.erased
        } else { declined () }
      }
    }
  }
}

fn read_plan (input:M.tape) (#frame:slprop) (start:U32.t)
  requires M.input_ready input ** frame
  returns plan:edit_plan
  ensures M.input_ready input ** frame
{
  let head = P.trivia input #frame start;
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
        let name_span = range name_start.at name.at;
        if (not init.ok) { declined () }
        else if (arrow) { arrow_plan input #frame name_span binding.erased (P.next init.at) }
        else {
          let end_ = expression_end input #frame init.at;
          let finish = declaration_end input #frame end_;
          if (finish.ok) { make_plan finish.at name_span binding.erased empty_span empty_span } else { declined () }
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
  : Tot (stt P.parser_state (heap input) (fun _ -> heap input)) (decreases U32.v fuel) =
  let! st = (fun () -> P.skip input state) in
  if st.status <> 0ul then ret input st
  else if st.offset = input.size then ret input (if module_seen then st else P.failed st 1ul)
  else if fuel = 0ul then ret input (P.failed st 1ul)
  else
    let! imported = (fun () -> P.keyword input st.offset 6ul 0x696d706f7274uL) in
    if imported then
      let! kind = (fun () -> P.skip input { st with offset = P.plus st.offset 6ul }) in
      let! typed = (fun () -> P.keyword input kind.offset 4ul 0x74797065uL) in
      let! first = (fun () -> P.skip input { kind with offset = P.plus kind.offset 4ul }) in
      let! value_import = (fun () -> P.keyword input first.offset 4ul 0x66726f6duL) in
      let! byte = (fun () -> peek input first.offset) in
      if not typed || value_import || first.status <> 0ul ||
        (not (G.identifier_start byte) && byte <> 123uy && byte <> 42uy) then ret input (P.failed st 1ul)
      else
        let! next = (fun () -> P.import_declaration input st used) in
        let! recorded = (fun () -> P.record_jsx_span input next.state 6ul st.offset next.state.offset) in
        type_only_statements input recorded next.used true (P.minus fuel 1ul)
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
      else if not (interface || alias) then ret input (P.failed st 1ul)
      else
        let! next = (fun () -> type_declaration input start used (if interface then 9ul else 4ul)) in
        let! recorded = (fun () -> P.record_jsx_span input next.state 6ul st.offset next.state.offset) in
        type_only_statements input recorded next.used (module_seen || exported) (P.minus fuel 1ul)

fn type_only_module (input:tape)
  requires heap input
  returns result:P.parse_result input
  ensures published input result.count
{
  unfold heap;
  let start = P.source_start input #(workspace_ready input);
  fold heap;
  let init = { (P.initial_state false true P.primary_locals) with offset = start };
  let parsed = type_only_statements input init 0ul false 512ul;
  if (parsed.status = 0ul && parsed.offset = input.size && U32.lte parsed.count input.capacity) {
    let full = certify_prefix input parsed.count;
    if full { parsed } else {
      let rejected = { (P.failed parsed 1ul) with count = 0ul };
      rewrite (published input 0ul) as (published input rejected.count);
      rejected
    }
  } else {
    let rejected = { (P.failed parsed 1ul) with count = 0ul };
    unfold heap;
    unfold workspace_ready;
    fold (published input rejected.count);
    rejected
  }
}

type runtime_head = {
  kind:U8.t; declaration:U32.t; body:U32.t; name_span:G.span;
  binding_type:G.span; parameter_type:G.span; return_type:G.span
}

let runtime_head_of (kind:U8.t) (declaration body:U32.t)
  (name_span binding_type parameter_type return_type:G.span) : runtime_head =
  { kind; declaration; body; name_span; binding_type; parameter_type; return_type }

let declined_runtime () = runtime_head_of 0uy 0ul 0ul empty_span empty_span empty_span empty_span

let rec jsx_group_start (input:tape) (#frame:slprop) (at fuel:U32.t)
  : Tot (stt bool (input_ready input ** frame) (fun _ -> input_ready input ** frame)) (decreases U32.v fuel) =
  let! start = (fun () -> P.trivia input #frame at) in
  let! byte = (fun () -> peek input #frame start.at) in
  if not start.ok then read_ret input #frame false
  else if byte = 40uy && U32.gt fuel 0ul then jsx_group_start input #frame (P.next start.at) (P.minus fuel 1ul)
  else read_ret input #frame (byte = 60uy)

fn jsx_callable_body (input:tape) (#frame:slprop)
  (declaration opening:U32.t) (name_span:G.span) (binding_type:G.span) (typescript function_:bool)
  requires input_ready input ** frame
  returns head:runtime_head
  ensures input_ready input ** frame
{
  let first = P.trivia input #frame (P.next opening);
  let no_params = P.same input #frame first.at 41uy;
  let parameter = if (no_params) {
    make_annotation first.ok first.at empty_span
  } else {
    let named = P.name input #frame first.at false true;
    if (first.ok && named.ok) { annotation_after input #frame named.at }
    else { make_annotation false first.at empty_span }
  };
  let close = P.trivia input #frame parameter.offset;
  let closes = P.same input #frame close.at 41uy;
  if (not (parameter.valid && close.ok && closes)) { declined_runtime () } else {
    let end_params = P.next close.at;
    let after = P.trivia input #frame end_params;
    let result = annotation_after input #frame end_params;
    let separator = P.trivia input #frame result.offset;
    if (not (after.ok && (function_ || not after.newline) && result.valid && separator.ok &&
        (typescript || (parameter.erased.G.first = parameter.erased.G.last && result.erased.G.first = result.erased.G.last)))) {
      declined_runtime ()
    } else {
      let body = if (function_) {
        let brace = P.same input #frame separator.at 123uy;
        let start = P.trivia input #frame (P.next separator.at);
        let return_ = P.keyword input #frame start.at 6ul 0x72657475726euL;
        let value = P.trivia input #frame (P.plus start.at 6ul);
        ({ value with P.ok = brace && start.ok && return_ && value.ok && not value.newline })
      } else {
        let equals = P.same input #frame separator.at 61uy;
        let greater = P.same input #frame (P.next separator.at) 62uy;
        let value = P.trivia input #frame (P.plus separator.at 2ul);
        ({ value with P.ok = not separator.newline && equals && greater && value.ok })
      };
      let element = jsx_group_start input #frame body.at 32ul;
      if (body.ok && element) {
        runtime_head_of (if function_ then 4uy else 2uy) declaration body.at name_span binding_type parameter.erased result.erased
      } else { declined_runtime () }
    }
  }
}

fn read_runtime_head (input:tape) (#frame:slprop) (at:U32.t) (jsx typescript local:bool)
  requires input_ready input ** frame
  returns head:runtime_head
  ensures input_ready input ** frame
{
  let start = P.trivia input #frame at;
  let exported = P.keyword input #frame start.at 6ul 0x6578706f7274uL;
  if (not (start.ok && (exported || local))) { declined_runtime () } else {
    let declaration = if (exported) { P.trivia input #frame (P.plus start.at 6ul) } else { start };
    let default_ = if (exported) { P.keyword input #frame declaration.at 7ul 0x64656661756c74uL } else { false };
    let callable = if (default_) { P.trivia input #frame (P.plus declaration.at 7ul) } else { declaration };
    let function_ = if (jsx) { P.keyword input #frame callable.at 8ul 0x66756e6374696f6euL } else { false };
    let constant = P.keyword input #frame declaration.at 5ul 0x636f6e7374uL;
    let after_const = if (constant) {
      P.trivia input #frame (P.plus declaration.at 5ul)
    } else { declaration };
    let enumeration = P.keyword input #frame after_const.at 4ul 0x656e756duL;
    if (callable.ok && function_) {
      let first = P.trivia input #frame (P.plus callable.at 8ul);
      let anonymous = P.same input #frame first.at 40uy;
      let named = P.name input #frame first.at false true;
      let opening = if (anonymous && default_) { first } else { P.trivia input #frame named.at };
      let paren = P.same input #frame opening.at 40uy;
      if (first.ok && opening.ok && paren && ((anonymous && default_) || named.ok)) {
        jsx_callable_body input #frame start.at opening.at empty_span empty_span typescript true
      } else { declined_runtime () }
    } else if (typescript && after_const.ok && enumeration) {
      let first = P.trivia input #frame (P.plus after_const.at 4ul);
      let name = P.name input #frame first.at false true;
      let open_brace = P.trivia input #frame name.at;
      let has_brace = P.same input #frame open_brace.at 123uy;
      if (first.ok && name.ok && open_brace.ok && has_brace) {
        runtime_head_of (if exported then 1uy else 3uy) start.at (P.next open_brace.at) (range first.at name.at) empty_span empty_span empty_span
      } else { declined_runtime () }
    } else if (jsx && constant && after_const.ok) {
      let name = P.name input #frame after_const.at false true;
      let annotation = annotation_after input #frame name.at;
      let equal = P.trivia input #frame annotation.offset;
      let assigned = P.same input #frame equal.at 61uy;
      if (name.ok && annotation.valid && equal.ok && assigned && (typescript || annotation.erased.G.first = annotation.erased.G.last)) {
        let init = P.trivia input #frame (P.next equal.at);
        let element = P.same input #frame init.at 60uy;
        let arrow = P.same input #frame init.at 40uy;
        let name_span = range after_const.at name.at;
        if (not init.ok) { declined_runtime () }
        else if (element) {
          runtime_head_of 2uy start.at init.at name_span annotation.erased empty_span empty_span
        } else if (arrow) {
          let grouped_element = jsx_group_start input #frame init.at 32ul;
          if (grouped_element) {
            runtime_head_of 2uy start.at init.at name_span annotation.erased empty_span empty_span
          } else {
            jsx_callable_body input #frame start.at init.at name_span annotation.erased typescript false
          }
        } else { declined_runtime () }
      } else { declined_runtime () }
    } else { declined_runtime () }
  }
}

fn runtime_tag_name (input:tape) (#frame:slprop) (at:U32.t)
  requires input_ready input ** frame
  returns name:P.cursor
  ensures input_ready input ** frame
{
  P.jsx_tag_name input #frame at 32ul
}

fn runtime_atom (input:tape) (#frame:slprop) (at:U32.t)
  requires input_ready input ** frame
  returns stop:P.cursor
  ensures input_ready input ** frame
{
  atom input #frame at
}

fn runtime_source_start (input:tape) (#frame:slprop)
  requires input_ready input ** frame
  returns start:P.cursor
  ensures input_ready input ** frame
{
  let at = P.source_start input #frame;
  P.trivia input #frame at
}

fn runtime_module_marker (input:tape) (#frame:slprop) (at:U32.t)
  requires input_ready input ** frame
  returns marked:bool
  ensures input_ready input ** frame
{
  let head = P.trivia input #frame at;
  if (not head.ok) { false } else {
    let exported = P.keyword input #frame head.at 6ul 0x6578706f7274uL;
    if (exported) {
      let after = P.plus head.at 6ul;
      let token = peek input #frame after;
      if (token = 226uy) { separator input #frame after }
      else { G.whitespace token || token = 47uy || token = 123uy || token = 42uy }
    } else {
      let imported = P.keyword input #frame head.at 6ul 0x696d706f7274uL;
      if (not imported) { false } else {
        let after = P.trivia input #frame (P.plus head.at 6ul);
        let token = peek input #frame after.at;
        // import A = B.C names a value and does not make the file a module; import x = require("m") does.
        let name_end = P.scan_class input #frame after.at G.Identifier;
        let assigned = P.trivia input #frame name_end;
        let equals = P.same input #frame assigned.at 61uy;
        let alias = after.ok && G.identifier_start token && assigned.ok && equals;
        if (alias) {
          let value = P.trivia input #frame (P.next assigned.at);
          let required = P.keyword input #frame value.at 7ul 0x72657175697265uL;
          let opening = P.trivia input #frame (P.plus value.at 7ul);
          let call = P.same input #frame opening.at 40uy;
          value.ok && required && opening.ok && call
        } else {
          after.ok && (G.identifier_start token || token = 39uy || token = 34uy || token = 123uy || token = 42uy)
        }
      }
    }
  }
}

fn supported_module (input:tape) (jsx:bool)
  requires heap input
  returns accepted:bool
  ensures heap input
{
  let result = P.parse_candidates input jsx true;
  result.status = 0ul
}

fn unbound_runtime_export (input:tape)
  requires heap input
  returns rejected:bool
  ensures heap input
{
  let result = P.parse_candidates input false true;
  result.status = P.unbound_runtime_export_status
}

fn supported_script (input:tape)
  requires heap input
  returns accepted:bool
  ensures heap input
{
  let result = P.parse_candidates input false false;
  result.status = 0ul
}

// The caller first validates the whole module. This pass recovers item boundaries
// without repeating the module's binding and deferred-export validation.
let ordinary_module_item_end (input:tape) (state:P.parser_state)
  : Tot (stt P.parser_state (heap input) (fun _ -> heap input)) =
  let! exported = (fun () -> P.module_export input state) in
  if exported.export_kind = 1ul then
    let! start = (fun () -> P.skip input { exported.after_export with offset = P.plus exported.after_export.offset 7ul }) in
    let! item = (fun () -> P.default_declaration input start state.offset 0ul) in
    ret input item.state
  else if exported.export_kind = 2ul then
    let! item = (fun () -> P.star_reexport input exported.after_export 0ul) in
    ret input item.state
  else if exported.export_kind = 3ul then
    let! item, _ = (fun () -> P.named_reexport input exported.after_export 0ul 0ul 0ul exported.type_only) in
    ret input item.state
  else if exported.export_kind = 4ul then ret input (P.failed state 1ul)
  else
    let! imported = (fun () -> P.keyword input state.offset 6ul 0x696d706f7274uL) in
    let! expression = (fun () -> if imported then P.import_expression_start input state else ret input false) in
    if imported && not expression then
      let! item = (fun () -> P.import_declaration input state 0ul) in
      ret input item.state
    else
      // Only the end of the item is asked here; names start afresh for each item.
      let! declaration = (fun () -> P.module_declaration input state 0ul true) in
      if declaration.state.status = 0ul then ret input declaration.state
      else
        let! control = (fun () -> P.control_statement input state 64ul false P.NoJump 0ul 0ul false) in
        ret input control.state

let module_item_end (input:tape) (state:P.parser_state)
  : Tot (stt P.parser_state (heap input) (fun _ -> heap input)) =
  let! first = (fun () -> peek input state.offset) in
  let! augmentation = (fun () -> if first = 100uy then P.global_augmentation_start input state else ret input (P.failed state 1ul)) in
  if augmentation.status = 0ul then
    let! closed, _ = (fun () -> P.global_augmentation_members input augmentation input.size 0uy) in
    ret input closed
  else
    // declare module 'name' { ... } holds interfaces only and is erased whole.
    let! ambient_module = (fun () -> if first = 100uy then P.ambient_module_start input state else ret input (P.failed state 1ul)) in
    if ambient_module.status = 0ul then
      let! interfaces = (fun () -> P.ambient_interfaces input ambient_module input.size true) in
      if interfaces.status = 0ul then ret input interfaces
      else P.type_namespace_members input ambient_module 0ul 0ul 0ul 8ul input.size true
    else ordinary_module_item_end input state

let next_module_boundary (input:tape) (jsx:bool) (at:U32.t)
  : Tot (stt U32.t (heap input) (fun _ -> heap input)) =
  let initial = P.initial_state jsx true P.primary_locals in
  let! undecorated = (fun () -> P.skip input { initial with offset = at }) in
  // Decorators belong to the class declaration that follows them.
  let! st = (fun () -> P.decorated_class_start input undecorated) in
  if st.status <> 0ul then ret input 0ul
  else if st.offset = input.size then ret input input.size
  else
    let! semicolon = (fun () -> P.same input st.offset 59uy) in
    let! end_ = (fun () -> if semicolon then P.consume input st 59uy else module_item_end input st) in
    ret input (if end_.status = 0ul && U32.gt end_.offset at && U32.lte end_.offset input.size then end_.offset else 0ul)

// An exported class may stand behind decorators. The item then marks a module like a plain export.
let decorated_export (input:tape) (jsx:bool) (at:U32.t)
  : Tot (stt bool (heap input) (fun _ -> heap input)) =
  let initial = P.initial_state jsx true P.primary_locals in
  let! undecorated = (fun () -> P.skip input { initial with offset = at }) in
  let! st = (fun () -> P.decorated_class_start input undecorated) in
  if st.status <> 0ul || st.offset = undecorated.offset then ret input false
  else P.keyword input st.offset 6ul 0x6578706f7274uL

fn decorated_module_marker (input:tape) (jsx:bool) (at:U32.t)
  requires heap input
  returns marked:bool
  ensures heap input
{
  decorated_export input jsx at
}

fn next_module_item (input:tape) (jsx:bool) (at:U32.t)
  requires heap input
  returns end_:U32.t
  ensures heap input
{
  next_module_boundary input jsx at
}

// The end of a JSX expression that is one operand with its member accesses and calls, and no operator.
fn jsx_operand_end (input:tape) (at:U32.t)
  requires heap input
  returns end_:P.cursor
  ensures heap input
{
  let initial = P.initial_state true true P.primary_locals;
  let value = P.atom input { initial with P.offset = at } 64ul;
  unfold heap;
  let end_ = P.skip input #(workspace_ready input) value.P.parser;
  let closed = P.same input #(workspace_ready input) end_.P.offset 125uy;
  fold heap;
  plain_cursor end_.P.offset (end_.P.status = 0ul && U32.gt end_.P.offset at && closed)
}

fn jsx_expression_end (input:tape) (at:U32.t)
  requires heap input
  returns end_:P.cursor
  ensures heap input
{
  let initial = P.initial_state true true P.primary_locals;
  let value = P.comparison input { initial with P.offset = at } 64ul;
  unfold heap;
  let end_ = P.skip input #(workspace_ready input) value.P.parser;
  let closed = P.same input #(workspace_ready input) end_.P.offset 125uy;
  fold heap;
  plain_cursor end_.P.offset (end_.P.status = 0ul && U32.gt end_.P.offset at && closed)
}
