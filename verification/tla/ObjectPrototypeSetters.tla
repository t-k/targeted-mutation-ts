------------------------ MODULE ObjectPrototypeSetters ------------------------
EXTENDS Naturals, Sequences

CONSTANT Depth
VARIABLES stack, accepted, rejected, finished

vars == <<stack, accepted, rejected, finished>>

Init ==
  /\ stack = <<>>
  /\ accepted = <<>>
  /\ rejected = FALSE
  /\ finished = FALSE

Enter ==
  /\ ~rejected /\ ~finished /\ Len(stack) < Depth
  /\ stack' = Append(stack, FALSE)
  /\ accepted' = Append(accepted, 0)
  /\ UNCHANGED <<rejected, finished>>

Setter ==
  /\ ~rejected /\ ~finished /\ Len(stack) > 0
  /\ IF stack[Len(stack)]
        THEN /\ rejected' = TRUE
             /\ UNCHANGED <<stack, accepted>>
        ELSE /\ stack' = [stack EXCEPT ![Len(stack)] = TRUE]
             /\ accepted' = [accepted EXCEPT ![Len(stack)] = @ + 1]
             /\ UNCHANGED rejected
  /\ UNCHANGED finished

Close ==
  /\ ~rejected /\ ~finished /\ Len(stack) > 0
  /\ stack' = SubSeq(stack, 1, Len(stack) - 1)
  /\ accepted' = SubSeq(accepted, 1, Len(accepted) - 1)
  /\ finished' = (Len(stack) = 1)
  /\ UNCHANGED rejected

Next == Enter \/ Setter \/ Close
Spec == Init /\ [][Next]_vars

SingleSetter ==
  /\ Len(stack) = Len(accepted)
  /\ \A p \in 1..Len(stack) :
        /\ accepted[p] <= 1
        /\ stack[p] = (accepted[p] = 1)

Publication == finished => ~rejected /\ Len(stack) = 0
=============================================================================
