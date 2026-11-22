----------------------------- MODULE LoopLabelScope -----------------------------
EXTENDS Naturals, Sequences

CONSTANTS Depth, Names, NoLabel
VARIABLES stack, last

vars == <<stack, last>>
Root == [kind |-> "function", label |-> NoLabel]
top == stack[Len(stack)]

Init ==
  /\ stack = <<Root>>
  /\ last = [target |-> NoLabel, accepted |-> FALSE]

EnterBlock ==
  /\ Len(stack) < Depth
  /\ stack' = Append(stack, [kind |-> "block", label |-> top.label])
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

EnterFunction ==
  /\ Len(stack) < Depth
  /\ stack' = Append(stack, Root)
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

EnterLoop ==
  /\ Len(stack) < Depth
  /\ top.label = NoLabel
  /\ \E label \in Names:
       stack' = Append(stack, [kind |-> "loop", label |-> label])
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

Close ==
  /\ Len(stack) > 1
  /\ stack' = SubSeq(stack, 1, Len(stack) - 1)
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

Jump ==
  /\ \E name \in Names:
       last' = [target |-> name, accepted |-> top.label = name]
  /\ UNCHANGED stack

Next == EnterBlock \/ EnterFunction \/ EnterLoop \/ Close \/ Jump
Spec == Init /\ [][Next]_vars

VisibleLoop(name) ==
  \E i \in 1..Len(stack):
    /\ stack[i].kind = "loop"
    /\ stack[i].label = name
    /\ \A j \in (i+1)..Len(stack): stack[j].kind # "function"

ScopeCorrect == \A label \in Names: (top.label = label) <=> VisibleLoop(label)
JumpCorrect == last.target # NoLabel => (last.accepted <=> VisibleLoop(last.target))
=================================================================================
