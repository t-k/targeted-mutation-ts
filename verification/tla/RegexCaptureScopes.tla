-------------------------- MODULE RegexCaptureScopes -------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES events, depth, seen, legacyOnly, rejected
vars == <<events, depth, seen, legacyOnly, rejected>>

Names == {"aa", "ab", "ba", "bb"}
Bits(name) == CASE name = "aa" -> {"low-a", "high-a"}
                [] name = "ab" -> {"low-a", "high-b"}
                [] name = "ba" -> {"low-b", "high-a"}
                [] OTHER -> {"low-b", "high-b"}
CaptureEvents == DOMAIN events
ObservedBefore(position) == UNION {Bits(events[i]) : i \in {j \in CaptureEvents : j < position /\ events[j] \in Names}}
Observed == ObservedBefore(Len(events) + 1)
Repeated == \E i,j \in CaptureEvents :
  i < j /\ events[i] \in Names /\ events[i] = events[j]
Collision == \E i \in CaptureEvents : events[i] \in Names /\ Bits(events[i]) \subseteq ObservedBefore(i)
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

Capture(name) ==
  /\ events' = Append(events, name)
  /\ rejected' = (Bits(name) \subseteq seen)
  /\ seen' = seen \cup Bits(name)
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
        /\ Enter \/ Leave \/ (\E name \in Names : Capture(name)) \/ RawBrace \/ Finish(TRUE) \/ Finish(FALSE)

Spec == Init /\ [][Next]_vars
CaptureHistory == /\ seen = Observed
                  /\ legacyOnly = HasRawBrace
                  /\ rejected = (Collision \/ (HasRawBrace /\ Unicode))
                  /\ (Repeated => rejected)
=============================================================================
