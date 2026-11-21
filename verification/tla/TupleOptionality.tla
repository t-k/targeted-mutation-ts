--------------------------- MODULE TupleOptionality ---------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES items, seenOptional, rejected
vars == <<items, seenOptional, rejected>>

Kinds == {"required", "optional", "rest"}
Indices == 1..Len(items)
ContainsOptional == \E i \in Indices : items[i] = "optional"
InvalidOrder == \E i,j \in Indices :
  i < j /\ items[i] = "optional" /\ items[j] = "required"

Init == /\ items = <<>>
        /\ seenOptional = FALSE
        /\ rejected = FALSE

Read(kind) ==
  /\ Len(items) < Capacity
  /\ ~rejected
  /\ items' = Append(items, kind)
  /\ rejected' = (kind = "required" /\ seenOptional)
  /\ seenOptional' = (seenOptional \/ kind = "optional")

Next == \E kind \in Kinds : Read(kind)
Spec == Init /\ [][Next]_vars
TupleOrder == /\ seenOptional = ContainsOptional
              /\ rejected = InvalidOrder
=============================================================================
