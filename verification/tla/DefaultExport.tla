----------------------------- MODULE DefaultExport -----------------------------
EXTENDS Naturals

CONSTANT Capacity
VARIABLES phase, defaults, seen, pending, published
vars == <<phase, defaults, seen, pending, published>>

Init ==
  /\ phase = "reading"
  /\ defaults = 0
  /\ seen = FALSE
  /\ pending = 0
  /\ published = 0

Ordinary(n) ==
  /\ phase = "reading"
  /\ pending + n <= Capacity
  /\ pending' = pending + n
  /\ UNCHANGED <<phase, defaults, seen, published>>

Default(n) ==
  /\ phase = "reading"
  /\ defaults' = defaults + 1
  /\ seen' = TRUE
  /\ IF seen \/ pending + n > Capacity
     THEN /\ phase' = "invalid"
          /\ pending' = pending
     ELSE /\ phase' = "reading"
          /\ pending' = pending + n
  /\ UNCHANGED published

Close(ok) ==
  /\ phase = "reading"
  /\ phase' = IF ok THEN "published" ELSE "invalid"
  /\ published' = IF ok THEN pending ELSE 0
  /\ UNCHANGED <<defaults, seen, pending>>

Next == (\E n \in 0..Capacity : Ordinary(n) \/ Default(n)) \/ (\E ok \in BOOLEAN : Close(ok))
Spec == Init /\ [][Next]_vars

Publication ==
  /\ seen = (defaults > 0)
  /\ phase \in {"reading", "published"} => defaults <= 1
  /\ phase = "published" => published = pending /\ published <= Capacity
  /\ phase # "published" => published = 0
=============================================================================
