-------------------------- MODULE BindingNamespaces ---------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Names, Capacity
VARIABLES slots, types, values, rejected
vars == <<slots, types, values, rejected>>

Kinds == {"Type", "Value", "Both"}
Overlaps(a, b) == a = b \/ a = "Both" \/ b = "Both"
TypeNames == {slots[i].name : i \in {j \in 1..Len(slots): slots[j].kind # "Value"}}
ValueNames == {slots[i].name : i \in {j \in 1..Len(slots): slots[j].kind # "Type"}}

Init ==
  /\ slots = <<>>
  /\ types = {}
  /\ values = {}
  /\ rejected = FALSE

Declare(name, kind) ==
  /\ ~rejected
  /\ Len(slots) < Capacity
  /\ rejected' = (\E i \in 1..Len(slots):
                    slots[i].name = name /\ Overlaps(slots[i].kind, kind))
  /\ slots' = IF rejected' THEN slots ELSE Append(slots, [name |-> name, kind |-> kind])
  /\ IF (kind # "Value" /\ name \in types) \/ (kind # "Type" /\ name \in values)
     THEN UNCHANGED <<types, values>>
     ELSE /\ types' = IF kind # "Value" THEN types \cup {name} ELSE types
          /\ values' = IF kind # "Type" THEN values \cup {name} ELSE values

Next == \E name \in Names, kind \in Kinds : Declare(name, kind)
Spec == Init /\ [][Next]_vars

NamespacesAgree ==
  /\ TypeNames = types
  /\ ValueNames = values
  /\ \A i,j \in 1..Len(slots):
      (i < j /\ slots[i].name = slots[j].name) => ~Overlaps(slots[i].kind, slots[j].kind)
=============================================================================
