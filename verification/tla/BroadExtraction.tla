--------------------------- MODULE BroadExtraction --------------------------
EXTENDS Naturals

VARIABLES phase, low, broad, oracle, count, rows
vars == <<phase, low, broad, oracle, count, rows>>

Init ==
  /\ phase = "low"
  /\ low \in {"accepted", "outside", "limited"}
  /\ broad \in {"accepted", "rejected", "unavailable", "invalidRows"}
  /\ oracle \in {"valid", "diagnostic"}
  /\ count \in 0..3
  /\ low = "accepted" => oracle = "valid"
  /\ broad = "accepted" => oracle = "valid"
  /\ rows = 0

Go(destination, published) ==
  /\ phase' = destination
  /\ rows' = published
  /\ UNCHANGED <<low, broad, oracle, count>>

Next ==
  \/ /\ phase = "low"
     /\ CASE low = "accepted" -> Go("lowResult", count)
          [] low = "outside" -> Go("broad", 0)
          [] OTHER -> Go("oracle", 0)
  \/ /\ phase = "broad"
     /\ IF broad = "accepted" THEN Go("broadResult", count) ELSE Go("oracle", 0)
  \/ /\ phase = "oracle"
     /\ IF oracle = "valid" THEN Go("oracleResult", count) ELSE Go("diagnostic", 0)

Spec == Init /\ [][Next]_vars

NoPartialRows ==
  /\ phase = "lowResult" => low = "accepted" /\ rows = count
  /\ phase = "broadResult" => low = "outside" /\ broad = "accepted" /\ rows = count
  /\ phase = "oracleResult" => oracle = "valid" /\ rows = count
  /\ phase \in {"low", "broad", "oracle", "diagnostic"} => rows = 0
=============================================================================
