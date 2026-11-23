---- MODULE CompilerPublication ----
EXTENDS Naturals, Sequences

Limits == 3
Offsets == 1..4
Operations == {"erase", "enum", "jsx"}
VARIABLES operation, mode, edits, output, checked
vars == <<operation, mode, edits, output, checked>>

Init == /\ operation \in Operations /\ mode = "scanning"
        /\ edits = <<>> /\ output = <<>> /\ checked = FALSE

Record ==
  /\ mode = "scanning" /\ Len(edits) < Limits
  /\ \E end \in Offsets:
       /\ (IF Len(edits) = 0 THEN TRUE ELSE end > edits[Len(edits)])
       /\ edits' = Append(edits, end)
  /\ UNCHANGED <<operation, mode, output, checked>>

ReplaceSignature ==
  /\ operation = "erase" /\ mode = "scanning" /\ Len(edits) > 0
  /\ \E prefix \in 0..(Len(edits) - 1), end \in Offsets:
       /\ end >= edits[Len(edits)]
       /\ edits' = Append(SubSeq(edits, 1, prefix), end)
  /\ UNCHANGED <<operation, mode, output, checked>>

Finish ==
  /\ mode = "scanning"
  /\ mode' \in {"complete", "fallback", "invalid"}
  /\ UNCHANGED <<operation, edits, output, checked>>

Validate ==
  /\ mode = "complete"
  /\ mode' \in {"validated", "invalid"}
  /\ checked' = (mode' = "validated")
  /\ UNCHANGED <<operation, edits, output>>

Publish ==
  /\ mode = "validated" /\ checked
  /\ mode' = "published" /\ output' = edits
  /\ UNCHANGED <<operation, edits, checked>>

Spec == Init /\ [][Record \/ ReplaceSignature \/ Finish \/ Validate \/ Publish]_vars
Ordered == \A i, j \in 1..Len(edits): i < j => edits[i] < edits[j]
Atomic == IF mode = "published" THEN checked /\ output = edits ELSE output = <<>>
====
