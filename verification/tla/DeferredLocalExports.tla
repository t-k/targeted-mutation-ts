------------------------------ MODULE DeferredLocalExports ------------------------------
EXTENDS FiniteSets, Naturals, Sequences

CONSTANTS Names, Aliases, Limit
VARIABLES locals, emitted, pending, phase

vars == <<locals, emitted, pending, phase>>
AllBound == \A index \in 1..Len(pending): pending[index] \in locals

Init ==
  /\ locals = {}
  /\ emitted = {}
  /\ pending = <<>>
  /\ phase = "open"

Define ==
  /\ phase = "open"
  /\ \E local \in Names \ locals: locals' = locals \cup {local}
  /\ UNCHANGED <<emitted, pending, phase>>

LocalExport ==
  /\ phase = "open"
  /\ \E alias \in Aliases \ emitted, local \in Names:
       IF local \notin locals /\ Len(pending) = Limit
       THEN /\ phase' = "refused"
            /\ UNCHANGED <<emitted, pending>>
       ELSE /\ emitted' = emitted \cup {alias}
            /\ pending' = IF local \in locals THEN pending ELSE Append(pending, local)
            /\ UNCHANGED phase
  /\ UNCHANGED locals

ReExport ==
  /\ phase = "open"
  /\ \E alias \in Aliases \ emitted: emitted' = emitted \cup {alias}
  /\ UNCHANGED <<locals, pending, phase>>

EOF ==
  /\ phase = "open"
  /\ phase' = IF AllBound THEN "published" ELSE "refused"
  /\ UNCHANGED <<locals, emitted, pending>>

Next == Define \/ LocalExport \/ ReExport \/ EOF
Spec == Init /\ [][Next]_vars

Bounded == Len(pending) <= Limit
Publication == (phase = "published") => AllBound
===========================================================================================
