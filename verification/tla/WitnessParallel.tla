--------------------------- MODULE WitnessParallel ---------------------------
\* Witness candidates are tried side by side, each in copies of the project that no other candidate sees.
\* A candidate's witness is verified only after its own trial survived, and the report lists candidates in their
\* planned order whatever order they finish in.
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Count, Limit

VARIABLES state, running, report

Candidates == 1..Count

Init == state = [c \in Candidates |-> "planned"] /\ running = {} /\ report = <<>>

\* Tasks start in order and never more than Limit run at once.
Start(c) ==
  /\ state[c] = "planned" /\ Cardinality(running) < Limit
  /\ \A d \in Candidates : d < c => state[d] # "planned"
  /\ state' = [state EXCEPT ![c] = "trial"] /\ running' = running \cup {c} /\ UNCHANGED report

Killed(c) == state[c] = "trial" /\ state' = [state EXCEPT ![c] = "killed"] /\ running' = running \ {c} /\ UNCHANGED report

Survived(c) == state[c] = "trial" /\ state' = [state EXCEPT ![c] = "verifying"] /\ UNCHANGED <<running, report>>

Verified(c, outcome) ==
  /\ state[c] = "verifying" /\ outcome \in {"confirmed", "unconfirmed"}
  /\ state' = [state EXCEPT ![c] = outcome] /\ running' = running \ {c} /\ UNCHANGED report

Done(c) == state[c] \in {"killed", "confirmed", "unconfirmed"}

\* The report is written once every task has settled, in the candidates' order.
Publish ==
  /\ report = <<>> /\ Count > 0 /\ \A c \in Candidates : Done(c)
  /\ report' = [c \in Candidates |-> <<c, state[c]>>] /\ UNCHANGED <<state, running>>

Next == Publish \/ \E c \in Candidates : Start(c) \/ Killed(c) \/ Survived(c) \/ Verified(c, "confirmed") \/ Verified(c, "unconfirmed")

vars == <<state, running, report>>
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

Bounded == Cardinality(running) <= Limit
Ordered == \A i \in 1..Len(report) : report[i][1] = i
\* A witness is confirmed only for a candidate whose own trial survived, and the report says what that candidate ended as.
Faithful == \A i \in 1..Len(report) : report[i][2] = state[i] /\ Done(i)
Published == <>(report # <<>>)
===============================================================================
