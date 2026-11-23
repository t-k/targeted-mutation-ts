module TmtPulseMemory
#lang-pulse

open Pulse.Lib.Pervasives
open Pulse.Lib.Array
module Array = Pulse.Lib.Array.Core
module Size = FStar.SizeT
module Seq = FStar.Seq
module U8 = FStar.UInt8
module U32 = FStar.UInt32
module G = TmtGrammar
module S = TmtPulseScan

type binding_namespace =
  | TypeName
  | InterfaceName
  | ExportedInterfaceName
  | TypeNamespace
  | ValueName
  | BothNames
  | FunctionSignature
  | FunctionImplementation
  | PrivateScope
  | PrivateDeclaration
  | PrivateReference
  | LocalLexicalName
  | LocalVarName

type binding_name = { span:G.span; namespace:binding_namespace; owner:U8.t }

let binding_region_width : U32.t = 512ul
let export_region_base : U32.t = 1024ul
let private_region_base : U32.t = 1536ul
let local_region_base : U32.t = 1791ul
let deferred_export_base : U32.t = 2303ul
let deferred_export_limit : U32.t = 64ul
let binding_capacity : U32.t = 2367ul

noeq type tape = {
  source : array U8.t;
  size : n:U32.t { U32.v n <= 1048576 };
  private_possible : bool;
  capture_jsx : bool;
  count_only : bool;
  output : array G.candidate;
  capacity : U32.t;
  bindings : array binding_name;
  marks : array U8.t
}

let owned (_:nat) : prop = True

// Lexical helpers receive a fractional source borrow. Their abstract frame stays outside it.
let input_ready (input:tape) : slprop =
  exists* (bytes:Seq.seq U8.t).
    pts_to input.source #0.5R bytes ** pure (Seq.length bytes == U32.v input.size)

let marked_prefix (marks:Seq.seq U8.t) (count:nat) : prop =
  forall (i:nat). i < count /\ i < Seq.length marks ==> Seq.index marks i == 1uy

let initialized_prefix (candidates:Seq.seq (option G.candidate)) (count:nat) : prop =
  count <= Seq.length candidates /\
  (forall (i:nat). i < count /\ i < Seq.length candidates ==> Some? (Seq.index candidates i))

let marks_sound (marks:Seq.seq U8.t) (candidates:Seq.seq (option G.candidate)) : prop =
  Seq.length marks == Seq.length candidates /\
  (forall (i:nat). i < Seq.length marks /\ i < Seq.length candidates /\ Seq.index marks i == 1uy ==>
    Some? (Seq.index candidates i))

let workspace_at (input:tape) (names:Seq.seq binding_name) (candidates:Seq.seq (option G.candidate))
  (marks:Seq.seq U8.t) : slprop =
  pts_to input.bindings names ** Array.pts_to_mask input.output candidates owned **
  pts_to input.marks marks ** pure (Seq.length names == U32.v binding_capacity /\
    Seq.length marks == U32.v input.capacity /\ marks_sound marks candidates)

let workspace_ready (input:tape) : slprop =
  exists* (names:Seq.seq binding_name) (candidates:Seq.seq (option G.candidate)) (marks:Seq.seq U8.t).
    workspace_at input names candidates marks

let heap (input:tape) : slprop = input_ready input ** workspace_ready input

let published (input:tape) (count:U32.t) : slprop =
  input_ready input ** (exists* (names:Seq.seq binding_name) (candidates:Seq.seq (option G.candidate)) (marks:Seq.seq U8.t).
    workspace_at input names candidates marks ** pure (initialized_prefix candidates (U32.v count)))

[@@FStar.Attributes.custard_inline]
fn sequence u#a u#b (#a:Type u#a) (#b:Type u#b) (#resources:slprop)
  (first:unit -> stt a resources (fun _ -> resources))
  (rest:a -> stt b resources (fun _ -> resources))
  requires resources
  returns result:b
  ensures resources
{
  let value = first ();
  rest value
}

[@@FStar.Attributes.custard_inline]
fn ret u#a (#a:Type u#a) (input:tape) (value:a)
  requires heap input
  returns result:a
  ensures heap input
{
  value
}

[@@FStar.Attributes.custard_inline]
fn read_ret u#a (#a:Type u#a) (input:tape) (#frame:slprop) (value:a)
  requires input_ready input ** frame
  returns result:a
  ensures input_ready input ** frame
{
  value
}

[@@FStar.Attributes.custard_inline]
let (let!) (#a #b:Type0) (#resources:slprop)
  (first:unit -> stt a resources (fun _ -> resources))
  (rest:a -> stt b resources (fun _ -> resources))
  : stt b resources (fun _ -> resources) =
  sequence (fun () -> first ()) (fun value -> rest value)

fn peek (input:tape) (#frame:slprop) (offset:U32.t)
  requires input_ready input ** frame
  returns byte:U8.t
  ensures input_ready input ** frame
{
  unfold input_ready;
  let byte = S.peek input.source input.size offset;
  fold input_ready;
  byte
}

fn separator (input:tape) (#frame:slprop) (offset:U32.t)
  requires input_ready input ** frame
  returns is_separator:bool
  ensures input_ready input ** frame
{
  unfold input_ready;
  let found = S.unicode_line_separator input.source input.size offset;
  fold input_ready;
  found
}

fn boundary (input:tape) (#frame:slprop) (offset:U32.t)
  requires input_ready input ** frame
  returns operator:U32.t
  ensures input_ready input ** frame
{
  unfold input_ready;
  let operator = S.source_boundary input.source input.size offset;
  fold input_ready;
  operator
}

fn scan_class (input:tape) (#frame:slprop) (offset:U32.t{U32.v offset <= U32.v input.size}) (code:U8.t{U8.v code <= 2})
  requires input_ready input ** frame
  returns stop:U32.t
  ensures input_ready input ** frame
{
  unfold input_ready;
  let stop = S.scan_class input.source input.size offset code;
  fold input_ready;
  stop
}

fn get_binding (input:tape) (offset:U32.t{U32.v offset < U32.v binding_capacity})
  requires heap input
  returns binding:binding_name
  ensures heap input
{
  unfold heap;
  unfold workspace_ready;
  unfold workspace_at;
  let binding = input.bindings.(Size.uint32_to_sizet offset);
  fold workspace_at;
  fold workspace_ready;
  fold heap;
  binding
}

fn set_binding (input:tape) (offset:U32.t{U32.v offset < U32.v binding_capacity}) (binding:binding_name)
  requires heap input
  ensures heap input
{
  unfold heap;
  unfold workspace_ready;
  unfold workspace_at;
  input.bindings.(Size.uint32_to_sizet offset) <- binding;
  fold workspace_at;
  fold workspace_ready;
  fold heap;
}

fn clear_marks (input:tape)
  requires heap input
  ensures heap input
{
  unfold heap;
  unfold workspace_ready;
  unfold workspace_at;
  pts_to_len input.marks;
  Pulse.Lib.Array.zeroize (Size.uint32_to_sizet input.capacity) input.marks;
  fold workspace_at;
  fold workspace_ready;
  fold heap;
}

fn prefix_marked (marks:array U8.t) (#values:FStar.Ghost.erased (Seq.seq U8.t))
  (count:U32.t{U32.v count <= Seq.length values})
  requires pts_to marks values
  returns full:bool
  ensures pts_to marks values ** pure (full <==> marked_prefix values (U32.v count))
{
  pts_to_len marks;
  let mut cursor = 0ul;
  while (let at = !cursor;
    if U32.lt at count { marks.(Size.uint32_to_sizet at) = 1uy } else { false })
  invariant exists* (at:U32.t). pts_to cursor at ** pts_to marks values ** pure (
    U32.v at <= U32.v count /\ marked_prefix values (U32.v at))
  decreases (U32.v count - U32.v !cursor)
  {
    cursor := U32.add !cursor 1ul;
  };
  let end_at = !cursor;
  end_at = count
}

fn certify_prefix (input:tape) (count:U32.t{U32.v count <= U32.v input.capacity})
  requires heap input
  returns full:bool
  ensures published input (if full then count else 0ul)
{
  unfold heap;
  unfold workspace_ready;
  unfold workspace_at;
  with candidates. assert (Array.pts_to_mask input.output candidates owned);
  let full = prefix_marked input.marks count;
  if full {
    assert (pure (initialized_prefix candidates (U32.v count)));
    fold workspace_at;
    fold (published input count);
    true
  } else {
    fold workspace_at;
    fold (published input 0ul);
    false
  }
}
