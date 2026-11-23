---- MODULE CompilerPublication ----
EXTENDS Naturals, Sequences

Limits == 3
Offsets == 1..4
Operations == {"erase", "enum", "jsx", "property", "javascript"}
RequiredAnchors == {"class", "constructor"}
\* leak: the projection retains syntax that JavaScript rejects. certified: the emitter proved it does not.
VARIABLES operation, mode, edits, output, checked, anchors, leak, certified
vars == <<operation, mode, edits, output, checked, anchors, leak, certified>>
Certifiable == {"erase", "enum", "jsx"}

Init == /\ operation \in Operations /\ mode = "scanning"
        /\ edits = <<>> /\ output = <<>> /\ checked = FALSE
        /\ anchors = {} /\ leak = FALSE /\ certified = FALSE

Record ==
  /\ mode = "scanning" /\ operation # "javascript" /\ Len(edits) < Limits
  /\ \E end \in Offsets:
       /\ (IF Len(edits) = 0 THEN TRUE ELSE end > edits[Len(edits)])
       /\ edits' = Append(edits, end)
  /\ UNCHANGED <<operation, mode, output, checked, anchors, leak, certified>>

ReplaceSignature ==
  /\ operation = "erase" /\ mode = "scanning" /\ Len(edits) > 0
  /\ \E prefix \in 0..(Len(edits) - 1), end \in Offsets:
       /\ end >= edits[Len(edits)]
       /\ edits' = Append(SubSeq(edits, 1, prefix), end)
  /\ UNCHANGED <<operation, mode, output, checked, anchors, leak, certified>>

Anchor ==
  /\ operation = "property" /\ mode = "scanning" /\ Len(edits) > 0
  /\ \E anchor \in RequiredAnchors \ anchors:
       anchors' = anchors \cup {anchor}
  /\ UNCHANGED <<operation, mode, edits, output, checked, leak, certified>>

Finish ==
  /\ mode = "scanning"
  /\ mode' \in {"complete", "fallback", "invalid"}
  /\ (mode' = "complete" /\ operation = "property") => anchors = RequiredAnchors
  /\ leak' \in BOOLEAN
  /\ certified' = (mode' = "complete" /\ operation \in Certifiable /\ ~leak')
  /\ UNCHANGED <<operation, edits, output, checked, anchors>>

Validate ==
  /\ mode = "complete"
  /\ mode' \in {"validated", "invalid"}
  /\ leak => mode' = "invalid"
  /\ checked' = (mode' = "validated")
  /\ UNCHANGED <<operation, edits, output, anchors, leak, certified>>

Publish ==
  /\ mode = "validated" /\ checked
  /\ mode' = "published" /\ output' = edits
  /\ UNCHANGED <<operation, edits, checked, anchors, leak, certified>>

\* A certified projection is published without the reparse.
PublishCertified ==
  /\ mode = "complete" /\ certified
  /\ mode' = "published" /\ output' = edits
  /\ UNCHANGED <<operation, edits, checked, anchors, leak, certified>>

Spec == Init /\ [][Record \/ ReplaceSignature \/ Anchor \/ Finish \/ Validate \/ Publish \/ PublishCertified]_vars
Ordered == \A i, j \in 1..Len(edits): i < j => edits[i] < edits[j]
Atomic == IF mode = "published" THEN (checked \/ certified) /\ output = edits ELSE output = <<>>
NoLeakPublished == mode = "published" => ~leak
UncertifiedValidated == mode = "published" /\ ~certified => checked
PropertyAnchored == operation = "property" /\ mode = "published" => anchors = RequiredAnchors
JavaScriptUnchanged == operation = "javascript" => edits = <<>> /\ output = <<>>
====
