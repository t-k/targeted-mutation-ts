------------------------------- MODULE MetaPropertyScope -------------------------------
EXTENDS Naturals, Sequences

CONSTANT Depth
VARIABLES stack

Root == [boundary |-> "top", newTarget |-> FALSE, superMember |-> FALSE]
Init == stack = <<Root>>
top == stack[Len(stack)]

Enter ==
  /\ Len(stack) < Depth
  /\ \E boundary \in {"function", "method", "field", "arrow"}:
       stack' = Append(stack,
         [boundary |-> boundary,
          newTarget |-> IF boundary = "arrow" THEN top.newTarget ELSE TRUE,
          superMember |-> IF boundary = "arrow" THEN top.superMember ELSE boundary # "function"])

Leave ==
  /\ Len(stack) > 1
  /\ stack' = SubSeq(stack, 1, Len(stack) - 1)

Spec == Init /\ [][Enter \/ Leave]_stack

ActiveBoundary ==
  LET boundaries == SelectSeq(stack, LAMBDA frame: frame.boundary # "arrow")
  IN boundaries[Len(boundaries)].boundary

NewTarget == top.newTarget = (ActiveBoundary # "top")
SuperMember == top.superMember = (ActiveBoundary \in {"method", "field"})
=========================================================================================
