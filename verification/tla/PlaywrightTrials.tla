------------------------- MODULE PlaywrightTrials -------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANT Attempts
None == "none"
VARIABLES owner, phase, publications, reports
vars == <<owner, phase, publications, reports>>

Init ==
  /\ owner = None
  /\ phase = [id \in Attempts |-> "new"]
  /\ publications = {}
  /\ reports = {}

Start(id) ==
  /\ owner = None
  /\ phase[id] = "new"
  /\ owner' = id
  /\ phase' = [phase EXCEPT ![id] = "running"]
  /\ UNCHANGED <<publications, reports>>

Deliver(id) ==
  /\ phase[id] \in {"running", "timed-out"}
  /\ id \notin reports
  /\ reports' = reports \cup {id}
  /\ UNCHANGED <<owner, phase, publications>>

Finish(id) ==
  /\ owner = id
  /\ phase[id] = "running"
  /\ id \in reports
  /\ owner' = None
  /\ phase' = [phase EXCEPT ![id] = "finished"]
  /\ publications' = publications \cup {id}
  /\ UNCHANGED reports

Expire(id) ==
  /\ owner = id
  /\ phase[id] = "running"
  /\ owner' = None
  /\ phase' = [phase EXCEPT ![id] = "timed-out"]
  /\ UNCHANGED <<publications, reports>>

Next == \E id \in Attempts: Start(id) \/ Deliver(id) \/ Finish(id) \/ Expire(id)
Spec == Init /\ [][Next]_vars

Exclusive ==
  /\ owner \in Attempts \cup {None}
  /\ {id \in Attempts : phase[id] = "running"} = IF owner = None THEN {} ELSE {owner}
SoundReport ==
  /\ publications \subseteq reports
  /\ publications = {id \in Attempts : phase[id] = "finished"}
=============================================================================
