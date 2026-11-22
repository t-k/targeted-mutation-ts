---- MODULE SignatureBindingFingerprints ----
EXTENDS FiniteSets, Naturals, Sequences

Names == {"first", "same-low", "same-high", "between", "collision"}
Low == [n \in Names |-> IF n \in {"first", "same-low", "collision"} THEN 1 ELSE 2]
High == [n \in Names |-> IF n \in {"first", "same-high", "collision"} THEN 1 ELSE 2]
VARIABLES accepted, low, high, phase
vars == <<accepted, low, high, phase>>

Init == /\ accepted = <<>> /\ low = {} /\ high = {} /\ phase = "open"

Add(name) ==
  IF Low[name] \in low /\ High[name] \in high
  THEN /\ phase' = "declined"
       /\ UNCHANGED <<accepted, low, high>>
  ELSE /\ accepted' = Append(accepted, name)
       /\ low' = low \cup {Low[name]}
       /\ high' = high \cup {High[name]}
       /\ UNCHANGED phase

Next == phase = "open" /\ \E name \in Names: Add(name)
Spec == Init /\ [][Next]_vars

RetainsBothBits ==
  \A i \in 1..Len(accepted): Low[accepted[i]] \in low /\ High[accepted[i]] \in high
NoDuplicate ==
  Cardinality({accepted[i]: i \in 1..Len(accepted)}) = Len(accepted)
====
