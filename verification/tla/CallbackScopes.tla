--------------------------- MODULE CallbackScopes ---------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES phase, table, outer, active, floor, consumed
vars == <<phase, table, outer, active, floor, consumed>>

Tokens == {"unused", "outer", "speculative", "body"}

Init ==
  /\ phase = "ready"
  /\ outer \in 0..Capacity
  /\ table = [i \in 1..Capacity |-> IF i <= outer THEN "outer" ELSE "unused"]
  /\ active = outer
  /\ floor = outer
  /\ consumed = 0

Next ==
  \/ /\ phase = "ready"
     /\ phase' = "head"
     /\ UNCHANGED <<table, outer, active, floor, consumed>>
  \/ /\ phase = "head"
     /\ consumed < Capacity - floor
     /\ table' = [table EXCEPT ![floor + consumed + 1] = "speculative"]
     /\ consumed' = consumed + 1
     /\ UNCHANGED <<phase, outer, active, floor>>
  \/ /\ phase = "head"
     /\ phase' = "body"
     /\ active' = floor + consumed
     /\ UNCHANGED <<table, outer, floor, consumed>>
  \/ /\ phase = "body"
     /\ active < Capacity
     /\ table' = [table EXCEPT ![active + 1] = "body"]
     /\ active' = active + 1
     /\ UNCHANGED <<phase, outer, floor, consumed>>
  \/ /\ phase \in {"head", "body"}
     /\ phase' = "returned"
     /\ active' = floor
     /\ UNCHANGED <<table, outer, floor, consumed>>

Spec == Init /\ [][Next]_vars

ScopeSafety ==
  /\ table \in [1..Capacity -> Tokens]
  /\ \A i \in 1..outer : table[i] = "outer"
  /\ active \in outer..Capacity
  /\ phase \in {"ready", "head", "returned"} => active = outer
  /\ phase = "body" => active >= floor + consumed
=============================================================================
