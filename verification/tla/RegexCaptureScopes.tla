-------------------------- MODULE RegexCaptureScopes -------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES events, depth, seen, legacyOnly, rejected
vars == <<events, depth, seen, legacyOnly, rejected>>

Buckets == {"bucket-a", "bucket-b", "bucket-c"}
CaptureEvents == DOMAIN events
Observed == {events[i] : i \in {j \in CaptureEvents : events[j] \in Buckets}}
Repeated == \E i,j \in CaptureEvents :
  i < j /\ events[i] \in Buckets /\ events[i] = events[j]
HasRawBrace == \E i \in CaptureEvents : events[i] = "raw-brace"
Unicode == \E i \in CaptureEvents : events[i] = "unicode-flags"
Finished == \E i \in CaptureEvents : events[i] \in {"unicode-flags", "legacy-flags"}

Init == /\ events = <<>>
        /\ depth = 0
        /\ seen = {}
        /\ legacyOnly = FALSE
        /\ rejected = FALSE

Enter ==
  /\ depth < Capacity
  /\ depth' = depth + 1
  /\ events' = Append(events, "enter")
  /\ UNCHANGED <<seen, legacyOnly, rejected>>

Leave ==
  /\ depth > 0
  /\ depth' = depth - 1
  /\ events' = Append(events, "leave")
  /\ UNCHANGED <<seen, legacyOnly, rejected>>

Capture(bucket) ==
  /\ events' = Append(events, bucket)
  /\ rejected' = (bucket \in seen)
  /\ seen' = seen \cup {bucket}
  /\ UNCHANGED <<depth, legacyOnly>>

RawBrace ==
  /\ events' = Append(events, "raw-brace")
  /\ legacyOnly' = TRUE
  /\ UNCHANGED <<depth, seen, rejected>>

Finish(unicode) ==
  /\ depth = 0
  /\ events' = Append(events, IF unicode THEN "unicode-flags" ELSE "legacy-flags")
  /\ rejected' = (unicode /\ legacyOnly)
  /\ UNCHANGED <<depth, seen, legacyOnly>>

Next == /\ Len(events) < Capacity
        /\ ~rejected /\ ~Finished
        /\ Enter \/ Leave \/ (\E bucket \in Buckets : Capture(bucket)) \/ RawBrace \/ Finish(TRUE) \/ Finish(FALSE)

Spec == Init /\ [][Next]_vars
CaptureHistory == /\ seen = Observed
                  /\ legacyOnly = HasRawBrace
                  /\ rejected = (Repeated \/ (HasRawBrace /\ Unicode))
=============================================================================
