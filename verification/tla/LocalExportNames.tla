------------------------- MODULE LocalExportNames -----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES bindings, sources, allKnown, origin, accepted
vars == <<bindings, sources, allKnown, origin, accepted>>

Names == {"a", "b", "c"}
Known == \A i \in DOMAIN sources : sources[i] \in bindings

Init == /\ bindings \in SUBSET Names
        /\ sources = <<>>
        /\ allKnown = TRUE
        /\ origin = "pending"
        /\ accepted = FALSE

Read(name) ==
  /\ Len(sources) < Capacity
  /\ sources' = Append(sources, name)
  /\ allKnown' = (allKnown /\ name \in bindings)
  /\ UNCHANGED <<bindings, origin, accepted>>

Close(kind) ==
  /\ origin' = kind
  /\ accepted' = (kind = "external" \/ allKnown)
  /\ UNCHANGED <<bindings, sources, allKnown>>

Next == /\ origin = "pending"
        /\ (\E name \in Names : Read(name)) \/ Close("local") \/ Close("external")

Spec == Init /\ [][Next]_vars
Availability == /\ allKnown = Known
                /\ accepted = (origin = "external" \/ (origin = "local" /\ Known))
=============================================================================
