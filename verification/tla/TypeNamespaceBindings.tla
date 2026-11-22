-------------------------- MODULE TypeNamespaceBindings --------------------------
EXTENDS FiniteSets, Naturals

CONSTANT Names
VARIABLES outer, inside, active, published, collision

vars == <<outer, inside, active, published, collision>>
Init ==
  /\ outer = {}
  /\ inside = {}
  /\ active = FALSE
  /\ published = FALSE
  /\ collision = FALSE

Enter ==
  /\ ~active /\ ~published /\ ~collision
  /\ \E name \in Names \ outer: outer' = outer \cup {name}
  /\ active' = TRUE
  /\ inside' = {}
  /\ UNCHANGED <<published, collision>>

Member ==
  /\ active /\ ~collision
  /\ \E name \in Names:
       /\ collision' = (name \in inside)
       /\ inside' = inside \cup {name}
  /\ UNCHANGED <<outer, active, published>>

Leave ==
  /\ active /\ ~collision
  /\ active' = FALSE
  /\ inside' = {}
  /\ UNCHANGED <<outer, published, collision>>

Publish ==
  /\ ~active /\ ~collision /\ ~published
  /\ published' = TRUE
  /\ UNCHANGED <<outer, inside, active, collision>>

Next == Enter \/ Member \/ Leave \/ Publish
Spec == Init /\ [][Next]_vars

NoLiveMembersOutside == ~active => inside = {}
Publication == published => ~active /\ ~collision /\ inside = {}
===============================================================================
