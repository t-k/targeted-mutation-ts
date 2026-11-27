---------------------------- MODULE SessionExtras ----------------------------
\* The session runs its planned trials while the focused analysis records comparisons. The analysis then names its
\* threshold trials, and the session runs them through shift switches. The list is written once, when the analysis
\* has planned, ended early or failed. A session that the caller aborts never reports.
EXTENDS Naturals, FiniteSets

CONSTANT Extras

VARIABLES focused, list, session, results

Init == focused = "preparing" /\ list = "absent" /\ session = "trials" /\ results = {}

\* The focused analysis plans its trials and names the ones a shift can run.
Plan == focused = "preparing" /\ focused' = "planned" /\ list' = "written" /\ UNCHANGED <<session, results>>

\* The analysis ends in its preparation: an empty list is written and the caller decides whether to stop the session.
EndEarly == focused = "preparing" /\ focused' = "ended" /\ list' = "empty" /\ UNCHANGED <<session, results>>

\* The preparation throws: an empty list is written and the session is aborted.
Fail == focused = "preparing" /\ focused' = "failed" /\ list' = "empty" /\ session' = "aborted" /\ UNCHANGED results

Abort == focused = "ended" /\ session \in {"trials", "waiting"} /\ session' = "aborted" /\ UNCHANGED <<focused, list, results>>

FinishTrials == session = "trials" /\ session' = "waiting" /\ UNCHANGED <<focused, list, results>>

\* The session reads the list only when it is complete.
Read ==
  /\ session = "waiting" /\ list # "absent"
  /\ session' = IF list = "written" THEN "extras" ELSE "complete"
  /\ UNCHANGED <<focused, list, results>>

RunExtra(e) == session = "extras" /\ e \notin results /\ results' = results \cup {e} /\ UNCHANGED <<focused, list, session>>

Complete == session = "extras" /\ results = Extras /\ session' = "complete" /\ UNCHANGED <<focused, list, results>>

Next == Plan \/ EndEarly \/ Fail \/ Abort \/ FinishTrials \/ Read \/ Complete \/ \E e \in Extras : RunExtra(e)

vars == <<focused, list, session, results>>
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* Extra trials run only for a list the analysis planned.
ExtrasNeedAPlan == results # {} => focused = "planned"

\* A complete session ran every listed extra, or had none to run.
CompleteMeansAll == session = "complete" => (results = Extras \/ list = "empty")

\* The session never waits forever: it completes or is aborted.
Ends == <>(session \in {"complete", "aborted"})
===============================================================================
