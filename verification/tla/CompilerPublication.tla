---- MODULE CompilerPublication ----
EXTENDS Naturals, Sequences

Limits == 3
Offsets == 1..4
Operations == {"erase", "enum", "jsx", "property"}
RequiredAnchors == {"class", "constructor"}
VARIABLES operation, mode, edits, output, checked, anchors
vars == <<operation, mode, edits, output, checked, anchors>>

Init == /\ operation \in Operations /\ mode = "scanning"
        /\ edits = <<>> /\ output = <<>> /\ checked = FALSE
        /\ anchors = {}

Record ==
  /\ mode = "scanning" /\ Len(edits) < Limits
  /\ \E end \in Offsets:
       /\ (IF Len(edits) = 0 THEN TRUE ELSE end > edits[Len(edits)])
       /\ edits' = Append(edits, end)
  /\ UNCHANGED <<operation, mode, output, checked, anchors>>

ReplaceSignature ==
  /\ operation = "erase" /\ mode = "scanning" /\ Len(edits) > 0
  /\ \E prefix \in 0..(Len(edits) - 1), end \in Offsets:
       /\ end >= edits[Len(edits)]
       /\ edits' = Append(SubSeq(edits, 1, prefix), end)
  /\ UNCHANGED <<operation, mode, output, checked, anchors>>

Anchor ==
  /\ operation = "property" /\ mode = "scanning" /\ Len(edits) > 0
  /\ \E anchor \in RequiredAnchors \ anchors:
       anchors' = anchors \cup {anchor}
  /\ UNCHANGED <<operation, mode, edits, output, checked>>

Finish ==
  /\ mode = "scanning"
  /\ mode' \in {"complete", "fallback", "invalid"}
  /\ (mode' = "complete" /\ operation = "property") => anchors = RequiredAnchors
  /\ UNCHANGED <<operation, edits, output, checked, anchors>>

Validate ==
  /\ mode = "complete"
  /\ mode' \in {"validated", "invalid"}
  /\ checked' = (mode' = "validated")
  /\ UNCHANGED <<operation, edits, output, anchors>>

Publish ==
  /\ mode = "validated" /\ checked
  /\ mode' = "published" /\ output' = edits
  /\ UNCHANGED <<operation, edits, checked, anchors>>

Spec == Init /\ [][Record \/ ReplaceSignature \/ Anchor \/ Finish \/ Validate \/ Publish]_vars
Ordered == \A i, j \in 1..Len(edits): i < j => edits[i] < edits[j]
Atomic == IF mode = "published" THEN checked /\ output = edits ELSE output = <<>>
PropertyAnchored == operation = "property" /\ mode = "published" => anchors = RequiredAnchors
====
