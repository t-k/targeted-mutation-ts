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
  | ValueName
  | BothNames
  | FunctionSignature
  | FunctionImplementation

type binding_name = { span:G.span; namespace:binding_namespace }

let binding_region_width : U32.t = 512ul
let export_region_base : U32.t = 1024ul

noeq type tape = {
  source : array U8.t;
  size : n:U32.t { U32.v n <= 1048576 };
  output : array G.candidate;
  capacity : U32.t;
  bindings : array binding_name
}

let owned (_:nat) : prop = True

// Lexical helpers receive a fractional source borrow. Their abstract frame stays outside it.
let input_ready (input:tape) : slprop =
  exists* (bytes:Seq.seq U8.t).
    pts_to input.source #0.5R bytes ** pure (Seq.length bytes == U32.v input.size)

let workspace_ready (input:tape) : slprop =
  exists* (names:Seq.seq binding_name) (candidates:Seq.seq (option G.candidate)).
    pts_to input.bindings names ** Array.pts_to_mask input.output candidates owned **
    pure (Seq.length names == 1536 /\ Seq.length candidates == U32.v input.capacity)

let heap (input:tape) : slprop = input_ready input ** workspace_ready input

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

fn get_binding (input:tape) (offset:U32.t{U32.v offset < 1536})
  requires heap input
  returns binding:binding_name
  ensures heap input
{
  unfold heap;
  unfold workspace_ready;
  let binding = input.bindings.(Size.uint32_to_sizet offset);
  fold workspace_ready;
  fold heap;
  binding
}

fn set_binding (input:tape) (offset:U32.t{U32.v offset < 1536}) (binding:binding_name)
  requires heap input
  ensures heap input
{
  unfold heap;
  unfold workspace_ready;
  input.bindings.(Size.uint32_to_sizet offset) <- binding;
  fold workspace_ready;
  fold heap;
}
