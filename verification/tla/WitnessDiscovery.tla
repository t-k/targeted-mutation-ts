------------------------- MODULE WitnessDiscovery -------------------------
EXTENDS TLC
VARIABLES kind, connected, firstSelected, secondSelected, seedPassed, proposed, witnessed, reported
vars == <<kind, connected, firstSelected, secondSelected, seedPassed, proposed, witnessed, reported>>
Init ==
  /\ kind \in {"pair", "state"}
  /\ connected \in BOOLEAN
  /\ firstSelected \in BOOLEAN
  /\ secondSelected \in BOOLEAN
  /\ seedPassed \in BOOLEAN
  /\ proposed = FALSE
  /\ witnessed = FALSE
  /\ reported = FALSE
Eligible == connected /\ firstSelected /\ (kind = "state" \/ secondSelected) /\ seedPassed
Propose ==
  /\ Eligible
  /\ proposed' = TRUE
  /\ UNCHANGED <<kind, connected, firstSelected, secondSelected, seedPassed, witnessed, reported>>
Check ==
  /\ proposed
  /\ witnessed' = TRUE
  /\ UNCHANGED <<kind, connected, firstSelected, secondSelected, seedPassed, proposed, reported>>
Report ==
  /\ witnessed
  /\ reported' = TRUE
  /\ UNCHANGED <<kind, connected, firstSelected, secondSelected, seedPassed, proposed, witnessed>>
Next == Propose \/ Check \/ Report
Spec == Init /\ [][Next]_vars
Attribution == reported => Eligible /\ witnessed
=============================================================================
