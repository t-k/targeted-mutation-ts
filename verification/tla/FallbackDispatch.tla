-------------------------- MODULE FallbackDispatch --------------------------
EXTENDS Naturals

VARIABLES phase, worker, direct, isolated, launches, outcome
vars == <<phase, worker, direct, isolated, launches, outcome>>

Init ==
  /\ phase = "start"
  /\ worker \in BOOLEAN
  /\ direct \in {"valid", "syntax", "stack", "transport"}
  /\ isolated \in {"valid", "syntax", "transport"}
  /\ launches = 0
  /\ outcome = "pending"

Dispatch ==
  /\ phase = "start"
  /\ IF worker
     THEN /\ phase' = "isolated" /\ launches' = 1
     ELSE /\ phase' = "direct" /\ launches' = 0
  /\ UNCHANGED <<worker, direct, isolated, outcome>>

Retry ==
  /\ phase = "direct" /\ direct = "stack"
  /\ phase' = "isolated" /\ launches' = launches + 1
  /\ UNCHANGED <<worker, direct, isolated, outcome>>

Finish ==
  /\ \/ /\ phase = "direct" /\ direct # "stack"
        /\ outcome' = direct
     \/ /\ phase = "isolated" /\ outcome' = isolated
  /\ phase' = "done"
  /\ UNCHANGED <<worker, direct, isolated, launches>>

Next == Dispatch \/ Retry \/ Finish
Spec == Init /\ [][Next]_vars

Atomic ==
  /\ phase # "done" => outcome = "pending"
  /\ phase = "done" => outcome = IF launches = 0 THEN direct ELSE isolated

Isolation ==
  /\ launches \in 0..1
  /\ phase = "direct" => ~worker
  /\ phase = "isolated" => launches = 1
  /\ ~worker /\ launches = 1 => direct = "stack"
=============================================================================
