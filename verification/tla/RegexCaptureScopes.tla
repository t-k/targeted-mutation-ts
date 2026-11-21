-------------------------- MODULE RegexCaptureScopes -------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES events, depth, seen, rejected
vars == <<events, depth, seen, rejected>>

Buckets == {"bucket-a", "bucket-b", "bucket-c"}
CaptureEvents == DOMAIN events
Observed == {events[i] : i \in {j \in CaptureEvents : events[j] \in Buckets}}
Repeated == \E i,j \in CaptureEvents :
  i < j /\ events[i] \in Buckets /\ events[i] = events[j]

Init == /\ events = <<>>
        /\ depth = 0
        /\ seen = {}
        /\ rejected = FALSE

Enter ==
  /\ depth < Capacity
  /\ depth' = depth + 1
  /\ events' = Append(events, "enter")
  /\ UNCHANGED <<seen, rejected>>

Leave ==
  /\ depth > 0
  /\ depth' = depth - 1
  /\ events' = Append(events, "leave")
  /\ UNCHANGED <<seen, rejected>>

Capture(bucket) ==
  /\ events' = Append(events, bucket)
  /\ rejected' = (bucket \in seen)
  /\ seen' = seen \cup {bucket}
  /\ UNCHANGED depth

Next == /\ Len(events) < Capacity
        /\ ~rejected
        /\ Enter \/ Leave \/ (\E bucket \in Buckets : Capture(bucket))

Spec == Init /\ [][Next]_vars
CaptureHistory == /\ seen = Observed
                  /\ rejected = Repeated
=============================================================================
