---- MODULE SignatureBindingFingerprints ----
EXTENDS FiniteSets, Naturals, Sequences

Names == {"first", "same-low", "same-high", "same-outer", "collision"}
Low == [n \in Names |-> IF n \in {"first", "same-low", "same-outer", "collision"} THEN 1 ELSE 2]
Middle == [n \in Names |-> IF n = "same-outer" THEN 2 ELSE 1]
High == [n \in Names |-> IF n \in {"first", "same-high", "same-outer", "collision"} THEN 1 ELSE 2]
VARIABLES accepted, low, middle, high, phase
vars == <<accepted, low, middle, high, phase>>

Init == /\ accepted = <<>> /\ low = {} /\ middle = {} /\ high = {} /\ phase = "open"

Add(name) ==
  IF Low[name] \in low /\ Middle[name] \in middle /\ High[name] \in high
  THEN /\ phase' = "declined"
       /\ UNCHANGED <<accepted, low, middle, high>>
  ELSE /\ accepted' = Append(accepted, name)
       /\ low' = low \cup {Low[name]}
       /\ middle' = middle \cup {Middle[name]}
       /\ high' = high \cup {High[name]}
       /\ UNCHANGED phase

Next == phase = "open" /\ \E name \in Names: Add(name)
Spec == Init /\ [][Next]_vars

RetainsAllBits ==
  \A i \in 1..Len(accepted): /\ Low[accepted[i]] \in low
                             /\ Middle[accepted[i]] \in middle
                             /\ High[accepted[i]] \in high
NoDuplicate ==
  Cardinality({accepted[i]: i \in 1..Len(accepted)}) = Len(accepted)
====
