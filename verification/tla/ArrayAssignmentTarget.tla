------------------------ MODULE ArrayAssignmentTarget ------------------------
EXTENDS Naturals, Sequences

CONSTANT Limit
VARIABLES elements, eligible, operator, result
vars == <<elements, eligible, operator, result>>

Elements == {"member", "hole", "other", "spread"}
Operators == {"plain", "compound", "none"}
Valid(items) == \A i \in DOMAIN items : items[i] \in {"member", "hole"}

Init == /\ elements = <<>>
        /\ eligible = TRUE
        /\ operator = "pending"
        /\ result = "pending"

Read(element) ==
  /\ Len(elements) < Limit
  /\ elements' = Append(elements, element)
  /\ eligible' = (eligible /\ element \in {"member", "hole"})
  /\ UNCHANGED <<operator, result>>

Close(op) ==
  /\ operator' = op
  /\ result' = IF op = "none" THEN "literal"
               ELSE IF op = "plain" /\ eligible THEN "assignment" ELSE "decline"
  /\ UNCHANGED <<elements, eligible>>

Next == /\ operator = "pending"
        /\ (\E element \in Elements : Read(element)) \/ (\E op \in Operators : Close(op))

Spec == Init /\ [][Next]_vars
Classification == /\ eligible = Valid(elements)
                  /\ (result = "assignment") <=> (operator = "plain" /\ Valid(elements))
                  /\ (result = "literal") <=> (operator = "none")
=============================================================================
