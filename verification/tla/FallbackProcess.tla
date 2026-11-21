--------------------------- MODULE FallbackProcess ---------------------------
EXTENDS Naturals

VARIABLES state, observedCandidates, publishedCandidates
vars == <<state, observedCandidates, publishedCandidates>>

Init == /\ state = "started"
        /\ observedCandidates = 0
        /\ publishedCandidates = 0

Receive(count) ==
  /\ state = "started"
  /\ state' = "received"
  /\ observedCandidates' = count
  /\ UNCHANGED publishedCandidates

Complete ==
  /\ state = "received"
  /\ state' = "complete"
  /\ publishedCandidates' = observedCandidates
  /\ UNCHANGED observedCandidates

Failure ==
  /\ state \in {"started", "received"}
  /\ state' = "failed"
  /\ UNCHANGED <<observedCandidates, publishedCandidates>>

Next == (\E count \in 0..3 : Receive(count)) \/ Complete \/ Failure
Spec == Init /\ [][Next]_vars
PublishOnlyComplete ==
  IF state = "complete" THEN publishedCandidates = observedCandidates
  ELSE publishedCandidates = 0
=============================================================================
