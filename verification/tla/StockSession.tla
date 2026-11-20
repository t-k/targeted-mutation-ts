--------------------------- MODULE StockSession ---------------------------
EXTENDS FiniteSets, TLC

CONSTANT Trials
NoOwner == "no-owner"
Outcomes == {"passed", "failed", "unreached", "timeout", "error", "unstable"}
VARIABLES phase, owner, started, outcomes
vars == <<phase, owner, started, outcomes>>

Init ==
  /\ phase = "baseline"
  /\ owner = NoOwner
  /\ started = {}
  /\ outcomes = [id \in {} |-> "error"]

PassBaseline ==
  /\ phase = "baseline"
  /\ phase' = "ready"
  /\ UNCHANGED <<owner, started, outcomes>>

Begin(id) ==
  /\ phase = "ready"
  /\ owner = NoOwner
  /\ id \notin started
  /\ owner' = id
  /\ started' = started \cup {id}
  /\ UNCHANGED <<phase, outcomes>>

Publish(id, result) ==
  /\ phase = "ready"
  /\ owner = id
  /\ owner' = NoOwner
  /\ outcomes' = [slot \in DOMAIN outcomes \cup {id} |->
       IF slot = id THEN result ELSE outcomes[slot]]
  /\ UNCHANGED <<phase, started>>

Abort ==
  /\ phase \in {"baseline", "ready"}
  /\ owner' = NoOwner
  /\ phase' = "aborted"
  /\ UNCHANGED <<started, outcomes>>

Complete ==
  /\ phase = "ready"
  /\ owner = NoOwner
  /\ DOMAIN outcomes = Trials
  /\ phase' = "complete"
  /\ UNCHANGED <<owner, started, outcomes>>

Next ==
  \/ PassBaseline
  \/ Abort
  \/ Complete
  \/ \E id \in Trials : Begin(id) \/
       (\E result \in Outcomes : Publish(id, result))

Spec == Init /\ [][Next]_vars
Exclusive ==
  /\ owner \in Trials \cup {NoOwner}
  /\ owner # NoOwner => owner \in started /\ owner \notin DOMAIN outcomes /\ phase = "ready"
Publication ==
  /\ DOMAIN outcomes \subseteq started
  /\ \A id \in DOMAIN outcomes : outcomes[id] \in Outcomes
  /\ phase = "baseline" => started = {}
  /\ phase = "complete" => DOMAIN outcomes = Trials
NeverChangesVerdict == [][\A id \in DOMAIN outcomes : id \in DOMAIN outcomes' /\ outcomes'[id] = outcomes[id]]_vars
=============================================================================
