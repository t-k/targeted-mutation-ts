---- MODULE CompilerPublication ----
EXTENDS Naturals, Sequences

Limits == 3
Offsets == 1..4
VARIABLES mode, edits, output
vars == <<mode, edits, output>>

Init == /\ mode = "scanning" /\ edits = <<>> /\ output = <<>>

Record ==
  /\ mode = "scanning" /\ Len(edits) < Limits
  /\ \E end \in Offsets:
       /\ (IF Len(edits) = 0 THEN TRUE ELSE end > edits[Len(edits)])
       /\ edits' = Append(edits, end)
  /\ UNCHANGED <<mode, output>>

Decide ==
  /\ mode = "scanning"
  /\ mode' \in {"validated", "fallback", "invalid"}
  /\ UNCHANGED <<edits, output>>

Publish ==
  /\ mode = "validated"
  /\ mode' = "published" /\ output' = edits
  /\ UNCHANGED edits

Spec == Init /\ [][Record \/ Decide \/ Publish]_vars
Ordered == \A i, j \in 1..Len(edits): i < j => edits[i] < edits[j]
Atomic == IF mode = "published" THEN output = edits ELSE output = <<>>
====
