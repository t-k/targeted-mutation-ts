module TmtScan

open FStar.HyperStack.ST
module U8 = FStar.UInt8
module U32 = FStar.UInt32
module C = LowStar.ConstBuffer
module Seq = FStar.Seq

let peek (source: C.const_buffer U8.t) (size: U32.t{U32.v size == C.length source}) (at: U32.t)
  : Stack U8.t
    (requires fun h -> C.live h source)
    (ensures fun h0 byte h1 -> h0 == h1 /\
      (if U32.v at < U32.v size then byte == Seq.index (C.as_seq h0 source) (U32.v at) else byte == 0uy))
  = if U32.(at <^ size) then C.index source at else 0uy

let source_boundary (source: C.const_buffer U8.t) (size: U32.t{U32.v size == C.length source}) (at: U32.t)
  : Stack U32.t
    (requires fun h -> C.live h source)
    (ensures fun h0 op h1 -> h0 == h1 /\
      (if U32.v at < U32.v size then
        op == TmtGrammar.boundary (Seq.index (C.as_seq h0 source) (U32.v at))
          (if U32.v at + 1 < U32.v size then Seq.index (C.as_seq h0 source) (U32.v at + 1) else 0uy)
       else op == 0ul))
  = if U32.(at <^ size) then
      let first = peek source size at in
      let second = peek source size (U32.add at 1ul) in
      TmtGrammar.boundary first second
    else 0ul

module B = LowStar.Buffer
module G = TmtGrammar

let rec scan_class (source: C.const_buffer U8.t) (size: U32.t{U32.v size == C.length source})
  (at: U32.t{U32.v at <= U32.v size}) (cls:G.byte_class)
  : Stack (stop:U32.t{U32.v at <= U32.v stop /\ U32.v stop <= U32.v size})
    (requires fun h -> C.live h source)
    (ensures fun h0 stop h1 ->
      h0 == h1 /\
      (forall (i:nat). U32.v at <= i /\ i < U32.v stop ==>
        G.in_class cls (Seq.index (C.as_seq h0 source) i)) /\
      (U32.v stop < U32.v size ==>
        not (G.in_class cls (Seq.index (C.as_seq h0 source) (U32.v stop)))))
    (decreases (U32.v size - U32.v at))
  = if U32.(at <^ size) then
      let byte = C.index source at in
      if G.in_class cls byte then scan_class source size (U32.add at 1ul) cls else at
    else at

let save_candidate (records:B.buffer G.candidate)
  (capacity:U32.t{U32.v capacity == B.length records})
  (slot:U32.t{U32.v slot < U32.v capacity}) (value:G.candidate)
  : Stack unit
    (requires fun h -> B.live h records)
    (ensures fun h0 _ h1 ->
      B.modifies (B.loc_buffer records) h0 h1 /\
      Seq.index (B.as_seq h1 records) (U32.v slot) == value)
  = B.upd records slot value
