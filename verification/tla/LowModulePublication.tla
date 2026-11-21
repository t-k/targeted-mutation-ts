------------------------ MODULE LowModulePublication ------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES phase, compactCount, moduleCount, compactAccepted, moduleAccepted,
          tryModule, rows, published
vars == <<phase, compactCount, moduleCount, compactAccepted, moduleAccepted,
          tryModule, rows, published>>

Init ==
  /\ phase = "compact"
  /\ compactCount \in 0..Capacity
  /\ moduleCount \in 0..Capacity
  /\ compactAccepted \in BOOLEAN
  /\ moduleAccepted \in BOOLEAN
  /\ tryModule \in BOOLEAN
  /\ rows = [i \in 1..Capacity |-> "empty"]
  /\ published = <<>>

Finish(origin, count, accepted, refusal) ==
  LET written == [i \in 1..Capacity |-> IF i <= count THEN origin ELSE rows[i]]
  IN /\ rows' = written
     /\ phase' = IF accepted THEN origin \o "Result" ELSE refusal
     /\ published' = IF accepted THEN SubSeq(written, 1, count) ELSE <<>>
     /\ UNCHANGED <<compactCount, moduleCount, compactAccepted, moduleAccepted, tryModule>>

Next ==
  \/ /\ phase = "compact"
     /\ Finish("compact", compactCount, compactAccepted, IF tryModule THEN "module" ELSE "declined")
  \/ /\ phase = "module"
     /\ Finish("module", moduleCount, moduleAccepted, "declined")

Spec == Init /\ [][Next]_vars

NoStaleRows ==
  /\ phase = "compactResult" => compactAccepted /\ published = [i \in 1..compactCount |-> "compact"]
  /\ phase = "moduleResult" => ~compactAccepted /\ tryModule /\ moduleAccepted
                               /\ published = [i \in 1..moduleCount |-> "module"]
  /\ phase \in {"compact", "module", "declined"} => published = <<>>
=============================================================================
