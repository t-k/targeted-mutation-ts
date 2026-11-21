---------------------------- MODULE LocalTypeScopes ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Capacity, Names
VARIABLES frames, checkpoints, slots, rejected
vars == <<frames, checkpoints, slots, rejected>>

Child == "child"
Shared == "shared"
FrameKind == {Child, Shared}

RECURSIVE Owner(_)
Owner(stack) ==
  IF Head(stack).kind = Child THEN 1 ELSE 1 + Owner(Tail(stack))

SlotNames(sequence) == {sequence[i] : i \in 1..Len(sequence)}

Init ==
  /\ frames = <<[kind |-> Child, declarations |-> {}]>>
  /\ checkpoints = <<0>>
  /\ slots = <<>>
  /\ rejected = FALSE

Enter(kind) ==
  /\ ~rejected
  /\ Len(frames) < Capacity
  /\ frames' = <<[kind |-> kind, declarations |-> {}]>> \o frames
  /\ checkpoints' = <<IF kind = Child THEN Len(slots) ELSE Head(checkpoints)>> \o checkpoints
  /\ UNCHANGED <<slots, rejected>>

Declare(name) ==
  /\ ~rejected
  /\ LET visible == SlotNames(SubSeq(slots, Head(checkpoints) + 1, Len(slots)))
         owner == Owner(frames)
     IN IF name \in visible
        THEN /\ rejected' = TRUE
             /\ UNCHANGED <<slots, frames>>
        ELSE /\ slots' = Append(slots, name)
             /\ frames' = [frames EXCEPT ![owner].declarations = @ \cup {name}]
             /\ UNCHANGED rejected
  /\ UNCHANGED checkpoints

Leave ==
  /\ ~rejected
  /\ Len(frames) > 1
  /\ slots' = IF Head(frames).kind = Child THEN SubSeq(slots, 1, Head(checkpoints)) ELSE slots
  /\ frames' = Tail(frames)
  /\ checkpoints' = Tail(checkpoints)
  /\ UNCHANGED rejected

Next == (\E kind \in FrameKind : Enter(kind)) \/ (\E name \in Names : Declare(name)) \/ Leave
Spec == Init /\ [][Next]_vars

SameScope ==
  /\ Len(frames) = Len(checkpoints)
  /\ LET active == SubSeq(slots, Head(checkpoints) + 1, Len(slots))
     IN /\ SlotNames(active) = frames[Owner(frames)].declarations
        /\ Len(active) = Cardinality(SlotNames(active))
=============================================================================
