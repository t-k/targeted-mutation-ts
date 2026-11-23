---------------------------- MODULE InWorkerTrials ----------------------------
\* One test file's mutations run inside a single worker. Each trial is followed by a control run of the same tests.
\* A failed control stops the file: that mutation and the ones not yet tried get a fresh Vitest run each.
\* A worker that stops answering is replaced; its mutation is a timeout and the rest continue.
\* The model assumes the control run notices a changed worker for the tests it runs.
EXTENDS Naturals, FiniteSets

CONSTANT Count

VARIABLES status, next, worker, stopped, cleanAtAnswer

Mutants == 1..Count
Final == {"worker", "timeout", "fresh"}

Init ==
  /\ status = [m \in Mutants |-> "planned"]
  /\ next = 1
  /\ worker = "clean"
  /\ stopped = FALSE
  /\ cleanAtAnswer = [m \in Mutants |-> FALSE]

InWorker == ~stopped /\ next \in Mutants /\ status[next] = "planned"

\* The trial leaves the worker as it was and the control passes: the worker's verdict stands.
Answer ==
  /\ InWorker /\ worker = "clean"
  /\ status' = [status EXCEPT ![next] = "worker"]
  /\ cleanAtAnswer' = [cleanAtAnswer EXCEPT ![next] = TRUE]
  /\ next' = next + 1
  /\ UNCHANGED <<worker, stopped>>

\* The trial, or an earlier one, changed the worker. The control fails and the file stops.
Stop ==
  /\ InWorker
  /\ worker' = "changed"
  /\ stopped' = TRUE
  /\ UNCHANGED <<status, next, cleanAtAnswer>>

\* The trial never returns. The worker is replaced by a clean one.
Stuck ==
  /\ InWorker
  /\ status' = [status EXCEPT ![next] = "timeout"]
  /\ next' = next + 1
  /\ worker' = "clean"
  /\ UNCHANGED <<stopped, cleanAtAnswer>>

\* What the worker did not decide runs in a fresh Vitest run.
Fresh(m) ==
  /\ stopped \/ next > Count
  /\ status[m] = "planned"
  /\ status' = [status EXCEPT ![m] = "fresh"]
  /\ UNCHANGED <<next, worker, stopped, cleanAtAnswer>>

Next == Answer \/ Stop \/ Stuck \/ \E m \in Mutants : Fresh(m)

Spec == Init /\ [][Next]_<<status, next, worker, stopped, cleanAtAnswer>>
  /\ WF_<<status, next, worker, stopped, cleanAtAnswer>>(Next)

TypeOK == status \in [Mutants -> {"planned"} \cup Final] /\ next \in 1..(Count + 1) /\ worker \in {"clean", "changed"}

\* A verdict from the worker was always taken with a passed control.
WorkerVerdictsAreControlled == \A m \in Mutants : status[m] = "worker" => cleanAtAnswer[m]

\* After the file stopped, the worker decides nothing more.
StoppedWorkerIsSilent == stopped => \A m \in Mutants : m >= next => status[m] # "worker"

\* A final verdict is never replaced.
Stable == [][\A m \in Mutants : status[m] \in Final => status'[m] = status[m]]_<<status, next, worker, stopped, cleanAtAnswer>>

\* Every mutation ends with exactly one final verdict.
AllDecided == <>[](\A m \in Mutants : status[m] \in Final)
===============================================================================
