------------------------- MODULE RegexBackreferences -------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Capacity
VARIABLES events, captures, rejected
vars == <<events, captures, rejected>>

References == 1..3
CapturesBefore(position) == Cardinality({i \in 1..(position - 1) : events[i] = 0})
MissingReference == \E i \in DOMAIN events :
  events[i] \in References /\ events[i] > CapturesBefore(i)

Init == /\ events = <<>>
        /\ captures = 0
        /\ rejected = FALSE

Group(capturing) ==
  /\ events' = Append(events, IF capturing THEN 0 ELSE 4)
  /\ captures' = IF capturing THEN captures + 1 ELSE captures
  /\ UNCHANGED rejected

ReadReference(index) ==
  /\ events' = Append(events, index)
  /\ rejected' = (index > captures)
  /\ UNCHANGED captures

Next == /\ Len(events) < Capacity
        /\ ~rejected
        /\ Group(TRUE) \/ Group(FALSE) \/ (\E index \in References : ReadReference(index))

Spec == Init /\ [][Next]_vars
CaptureOrder == /\ captures = CapturesBefore(Len(events) + 1)
                /\ rejected = MissingReference
=============================================================================
