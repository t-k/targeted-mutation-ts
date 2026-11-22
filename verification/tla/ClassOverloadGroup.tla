---- MODULE ClassOverloadGroup ----
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES events, pending, closed
vars == <<events, pending, closed>>
Keys == {"plain-a", "plain-b", "async-a", "static-a"}
Empty == ""

Init == /\ events = <<>> /\ pending = Empty /\ closed = FALSE

Step ==
  /\ Len(events) < Capacity
  /\ \/ \E key \in Keys:
          /\ pending \in {Empty, key}
          /\ events' = Append(events, [type |-> "signature", key |-> key])
          /\ pending' = key
     \/ \E key \in Keys:
          /\ pending \in {Empty, key}
          /\ events' = Append(events, [type |-> "method", key |-> key])
          /\ pending' = Empty
     \/ /\ pending = Empty
        /\ events' = Append(events, [type |-> "field", key |-> Empty])
        /\ pending' = Empty
  /\ UNCHANGED closed

Close == /\ pending = Empty /\ closed' = TRUE /\ UNCHANGED <<events, pending>>
Next == ~closed /\ (Step \/ Close)
Spec == Init /\ [][Next]_vars

CompleteGroups == closed =>
  \A i \in 1..Len(events):
    events[i].type = "signature" =>
      \E j \in (i + 1)..Len(events):
        /\ events[j].type = "method"
        /\ events[j].key = events[i].key
        /\ \A k \in i..(j - 1): events[k] = events[i]
====
