module TmtPulseScan
#lang-pulse

open Pulse.Lib.Pervasives
open Pulse.Lib.Array
module U8 = FStar.UInt8
module U32 = FStar.UInt32
module Size = FStar.SizeT
module Seq = FStar.Seq
module G = TmtGrammar

let prefix (bytes:Seq.seq U8.t) (cls:G.byte_class) (start stop:nat) : prop =
  forall (i:nat). start <= i /\ i < stop /\ i < Seq.length bytes ==> G.in_class cls (Seq.index bytes i)

let byte_class (code:U8.t) : G.byte_class =
  if code = 0uy then G.Space else if code = 1uy then G.Identifier else G.DecimalDigits

let in_class (code byte:U8.t) : b:bool{b == G.in_class (byte_class code) byte} =
  if code = 0uy then G.whitespace byte
  else if code = 1uy then G.identifier_continue byte
  else G.decimal_digit byte

fn scan_class (source:array U8.t) (size:U32.t) (start:U32.t{U32.v start <= U32.v size})
  (code:U8.t{U8.v code <= 2}) (#p:perm) (#bytes:FStar.Ghost.erased (Seq.seq U8.t))
  requires pts_to source #p bytes ** pure (U32.v size == Seq.length bytes)
  returns stop:U32.t
  ensures pts_to source #p bytes ** pure (
    U32.v start <= U32.v stop /\ U32.v stop <= U32.v size /\
    prefix bytes (byte_class code) (U32.v start) (U32.v stop) /\
    (U32.v stop < Seq.length bytes ==> not (G.in_class (byte_class code) (Seq.index bytes (U32.v stop)))))
{
  pts_to_len source #p #bytes;
  let mut cursor = start;
  while (let at = !cursor;
    if (U32.lt at size) { in_class code source.(Size.uint32_to_sizet at) }
    else { false })
  invariant exists* (at:U32.t). pts_to cursor at ** pts_to source #p bytes ** pure (
    U32.v start <= U32.v at /\ U32.v at <= U32.v size /\ prefix bytes (byte_class code) (U32.v start) (U32.v at))
  decreases (U32.v size - U32.v !cursor)
  {
    cursor := U32.add !cursor 1ul;
  };
  !cursor
}
