---- MODULE FrameworkDeclarationGroups ----
EXTENDS FiniteSets, Naturals, Sequences

CONSTANT Capacity
VARIABLES mode, slots, floors, scopes, signatures, implementations, closed
vars == <<mode, slots, floors, scopes, signatures, implementations, closed>>
Names == {"a", "b", "c"}
Heads == Names \X {"sync", "async"}
Top(sequence) == sequence[Len(sequence)]
Pop(sequence) == SubSeq(sequence, 1, Len(sequence) - 1)
CurrentNames == {slots[i]: i \in (Top(floors) + 1)..Len(slots)}

Init ==
  /\ mode \in {"namespace", "function"}
  /\ slots = <<>> /\ floors = <<0>> /\ scopes = <<{}>>
  /\ signatures = <<>> /\ implementations = <<>> /\ closed = FALSE

Bind(name, enter) ==
  /\ Len(slots) < Capacity
  /\ name \in Names \ CurrentNames
  /\ slots' = Append(slots, name)
  /\ IF enter THEN /\ floors' = Append(floors, Len(slots'))
                    /\ scopes' = Append(Append(Pop(scopes), Top(scopes) \cup {name}), {})
              ELSE /\ floors' = floors
                   /\ scopes' = Append(Pop(scopes), Top(scopes) \cup {name})
  /\ UNCHANGED <<closed, signatures, implementations>>

Exit ==
  /\ Len(floors) > 1
  /\ slots' = SubSeq(slots, 1, Top(floors))
  /\ floors' = Pop(floors)
  /\ scopes' = Pop(scopes)
  /\ UNCHANGED <<closed, signatures, implementations>>

NamespaceStep ==
  \/ \E name \in Names: Bind(name, FALSE) \/ Bind(name, TRUE)
  \/ Exit
  \/ /\ Len(floors) = 1
     /\ closed' = TRUE
     /\ UNCHANGED <<slots, floors, scopes, signatures, implementations>>

FunctionStep ==
  /\ implementations = <<>>
  /\ \E head \in Heads:
       /\ IF signatures = <<>> THEN TRUE ELSE head = signatures[1]
       /\ \/ /\ Len(signatures) < Capacity
             /\ signatures' = Append(signatures, head)
             /\ UNCHANGED <<closed, implementations>>
          \/ /\ implementations' = <<head>>
             /\ closed' = TRUE
             /\ UNCHANGED signatures
  /\ UNCHANGED <<slots, floors, scopes>>

Next == /\ ~closed /\ UNCHANGED mode
        /\ IF mode = "namespace" THEN NamespaceStep ELSE FunctionStep
Spec == Init /\ [][Next]_vars

ScopedBindings ==
  /\ Len(scopes) = Len(floors)
  /\ \A i \in 1..Len(floors):
       LET stop == IF i = Len(floors) THEN Len(slots) ELSE floors[i + 1] IN
       LET indices == (floors[i] + 1)..stop IN
       /\ scopes[i] = {slots[j]: j \in indices}
       /\ Cardinality(scopes[i]) = Cardinality(indices)
CompleteDefault == mode = "function" /\ closed =>
  /\ Len(implementations) = 1
  /\ \A i \in 1..Len(signatures): signatures[i] = implementations[1]
====
