---- MODULE LowModulePublication ----
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES phase, compact, expanded, tryModule, rows, marks, published
vars == <<phase, compact, expanded, tryModule, rows, marks, published>>

Slots == 1..Capacity
Attempts == [count: 0..Capacity, writes: SUBSET Slots, accepted: BOOLEAN]
Prefix(count) == 1..count
Init ==
  /\ phase = "compact"
  /\ compact \in Attempts
  /\ expanded \in Attempts
  /\ tryModule \in BOOLEAN
  /\ rows = [i \in Slots |-> "empty"]
  /\ marks = {}
  /\ published = <<>>

Finish(origin, attempt, refusal) ==
  LET written == [i \in Slots |-> IF i \in attempt.writes THEN origin ELSE rows[i]]
      done == marks \cup attempt.writes
      valid == attempt.accepted /\ Prefix(attempt.count) \subseteq done
  IN /\ rows' = written
     /\ phase' = IF valid THEN origin \o "Result" ELSE refusal
     /\ marks' = IF phase' = "module" THEN {} ELSE done
     /\ published' = IF valid THEN SubSeq(written, 1, attempt.count) ELSE <<>>
     /\ UNCHANGED <<compact, expanded, tryModule>>

Next ==
  \/ /\ phase = "compact"
     /\ Finish("compact", compact, IF tryModule THEN "module" ELSE "declined")
  \/ /\ phase = "module"
     /\ Finish("module", expanded, "declined")

Spec == Init /\ [][Next]_vars

NoStaleRows ==
  /\ phase = "compactResult" => compact.accepted /\ published = [i \in Prefix(compact.count) |-> "compact"]
  /\ phase = "moduleResult" => tryModule /\ expanded.accepted /\ published = [i \in Prefix(expanded.count) |-> "module"]
  /\ phase \in {"compact", "module", "declined"} => published = <<>>
  /\ \A i \in marks : rows[i] # "empty"
====
