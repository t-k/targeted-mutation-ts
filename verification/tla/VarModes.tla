------------------------------ MODULE VarModes ------------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Capacity
VARIABLES frames, modes, declared, rejected
vars == <<frames, modes, declared, rejected>>

Root == "function"
Block == "block"
Empty == "none"
Kinds == {"var", "lexical"}

Init ==
  /\ frames = <<Root>>
  /\ modes = <<Empty>>
  /\ declared = <<{}>>
  /\ rejected = FALSE

Enter(kind) ==
  /\ ~rejected
  /\ Len(frames) < Capacity
  /\ frames' = <<kind>> \o frames
  /\ modes' = IF kind = Root THEN <<Empty>> \o modes ELSE modes
  /\ declared' = IF kind = Root THEN <<{}>> \o declared ELSE declared
  /\ UNCHANGED rejected

Declare(kind) ==
  /\ ~rejected
  /\ rejected' = (Head(modes) \notin {Empty, kind})
  /\ declared' = <<Head(declared) \cup {kind}>> \o Tail(declared)
  /\ modes' = IF rejected' THEN modes ELSE <<kind>> \o Tail(modes)
  /\ UNCHANGED frames

Leave ==
  /\ ~rejected
  /\ Len(frames) > 1
  /\ frames' = Tail(frames)
  /\ modes' = IF Head(frames) = Root THEN Tail(modes) ELSE modes
  /\ declared' = IF Head(frames) = Root THEN Tail(declared) ELSE declared
  /\ UNCHANGED rejected

Next == (\E kind \in {Root, Block}: Enter(kind)) \/ (\E kind \in Kinds: Declare(kind)) \/ Leave
Spec == Init /\ [][Next]_vars

ModesDescribeBindings ==
  /\ Len(declared) = Len(modes)
  /\ Len(modes) = Cardinality({i \in 1..Len(frames): frames[i] = Root})
  /\ rejected = (Cardinality(Head(declared)) = 2)
  /\ \A i \in 1..Len(declared):
       IF rejected /\ i = 1 THEN modes[i] \in declared[i]
       ELSE IF modes[i] = Empty THEN declared[i] = {} ELSE declared[i] = {modes[i]}
=============================================================================
