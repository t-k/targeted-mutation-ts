----------------------------- MODULE LoopLabelScope -----------------------------
EXTENDS FiniteSets, Naturals, Sequences

CONSTANTS Depth, Names, NoLabel
VARIABLES stack, last

vars == <<stack, last>>
Root == [kind |-> "function", label |-> NoLabel, visible |-> {}]
top == stack[Len(stack)]

Init ==
  /\ stack = <<Root>>
  /\ last = [target |-> NoLabel, accepted |-> FALSE]

EnterBlock ==
  /\ Len(stack) < Depth
  /\ stack' = Append(stack, [kind |-> "block", label |-> NoLabel, visible |-> top.visible])
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

EnterFunction ==
  /\ Len(stack) < Depth
  /\ stack' = Append(stack, Root)
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

EnterLoop ==
  /\ Len(stack) < Depth
  /\ Cardinality(top.visible) < 2
  /\ \E label \in Names \ top.visible:
       stack' = Append(stack, [kind |-> "loop", label |-> label, visible |-> top.visible \cup {label}])
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

Close ==
  /\ Len(stack) > 1
  /\ stack' = SubSeq(stack, 1, Len(stack) - 1)
  /\ last' = [target |-> NoLabel, accepted |-> FALSE]

Jump ==
  /\ \E name \in Names:
       last' = [target |-> name, accepted |-> name \in top.visible]
  /\ UNCHANGED stack

Next == EnterBlock \/ EnterFunction \/ EnterLoop \/ Close \/ Jump
Spec == Init /\ [][Next]_vars

VisibleLoop(name) ==
  \E i \in 1..Len(stack):
    /\ stack[i].kind = "loop"
    /\ stack[i].label = name
    /\ \A j \in (i+1)..Len(stack): stack[j].kind # "function"

ScopeCorrect == \A label \in Names: (label \in top.visible) <=> VisibleLoop(label)
JumpCorrect == last.target # NoLabel => (last.accepted <=> VisibleLoop(last.target))
=================================================================================
