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
  if code = 0uy then G.Space else if code = 1uy then G.Identifier
  else if code = 2uy then G.DecimalDigits else G.HorizontalSpace

let in_class (code byte:U8.t) : b:bool{b == G.in_class (byte_class code) byte} =
  if code = 0uy then G.whitespace byte
  else if code = 1uy then G.identifier_continue byte
  else if code = 2uy then G.decimal_digit byte
  else G.horizontal_space byte

fn scan_class (source:array U8.t) (size:U32.t) (start:U32.t{U32.v start <= U32.v size})
  (code:U8.t{U8.v code <= 3}) (#p:perm) (#bytes:FStar.Ghost.erased (Seq.seq U8.t))
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

fn peek (source:array U8.t) (#bytes:FStar.Ghost.erased (Seq.seq U8.t))
  (size:U32.t{U32.v size == Seq.length bytes}) (at:U32.t) (#p:perm)
  requires pts_to source #p bytes
  returns byte:U8.t
  ensures pts_to source #p bytes ** pure (byte ==
    (if U32.v at < U32.v size then Seq.index bytes (U32.v at) else 0uy))
{
  pts_to_len source #p #bytes;
  if (U32.lt at size) { source.(Size.uint32_to_sizet at) }
  else { 0uy }
}

let is_unicode_line_separator (bytes:Seq.seq U8.t) (at:nat) : prop =
  at + 2 < Seq.length bytes /\ Seq.index bytes at == 226uy /\ Seq.index bytes (at + 1) == 128uy /\
    (Seq.index bytes (at + 2) == 168uy \/ Seq.index bytes (at + 2) == 169uy)

fn unicode_line_separator (source:array U8.t) (#bytes:FStar.Ghost.erased (Seq.seq U8.t))
  (size:U32.t{U32.v size == Seq.length bytes}) (at:U32.t) (#p:perm)
  requires pts_to source #p bytes
  returns separator:bool
  ensures pts_to source #p bytes ** pure (separator <==> is_unicode_line_separator bytes (U32.v at))
{
  if (U32.lt at size && U32.gt (U32.sub size at) 2ul) {
    let first = peek source size at;
    let second = peek source size (U32.add at 1ul);
    let third = peek source size (U32.add at 2ul);
    first = 226uy && second = 128uy && (third = 168uy || third = 169uy)
  } else { false }
}

fn source_boundary (source:array U8.t) (#bytes:FStar.Ghost.erased (Seq.seq U8.t))
  (size:U32.t{U32.v size == Seq.length bytes}) (at:U32.t) (#p:perm)
  requires pts_to source #p bytes
  returns operator:U32.t
  ensures pts_to source #p bytes ** pure (operator == (if U32.v at < U32.v size then
    G.boundary (Seq.index bytes (U32.v at))
      (if U32.v at + 1 < U32.v size then Seq.index bytes (U32.v at + 1) else 0uy)
    else 0ul))
{
  if (U32.lt at size) {
    let first = peek source size at;
    let second = peek source size (U32.add at 1ul);
    G.boundary first second
  } else { 0ul }
}

module Array = Pulse.Lib.Array.Core

fn save_candidate (records:array G.candidate) (#values:FStar.Ghost.erased (Seq.seq (option G.candidate)))
  (slot:U32.t{U32.v slot < Seq.length values}) (candidate:G.candidate) (#mask:nat -> prop)
  requires Array.pts_to_mask records values mask ** pure (mask (U32.v slot))
  ensures Array.pts_to_mask records (Seq.upd values (U32.v slot) (Some candidate)) mask
{
  Array.pts_to_mask_len records;
  Array.mask_write records (Size.uint32_to_sizet slot) candidate;
}
