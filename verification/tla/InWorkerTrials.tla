---------------------------- MODULE InWorkerTrials ----------------------------
\* One test file's mutations run inside a single worker. Each trial is followed by a control run of the same tests.
\* A failed control leaves that mutation to a fresh Vitest run and the file continues in a new worker.
\* After MaxRestarts such restarts the file stops and the ones not yet tried get fresh runs too.
\* A worker that stops answering is replaced; its mutation is a timeout and the rest continue.
\* The model assumes the control run notices a changed worker for the tests it runs.
EXTENDS Naturals, FiniteSets

CONSTANTS Count, MaxRestarts

VARIABLES status, next, worker, stopped, cleanAtAnswer, restarts

Mutants == 1..Count
Final == {"worker", "timeout", "fresh"}

Init ==
  /\ status = [m \in Mutants |-> "planned"]
  /\ next = 1
  /\ worker = "clean"
  /\ stopped = FALSE
  /\ cleanAtAnswer = [m \in Mutants |-> FALSE]
  /\ restarts = 0

InWorker == ~stopped /\ next \in Mutants /\ status[next] = "planned"

\* The trial leaves the worker as it was and the control passes: the worker's verdict stands.
Answer ==
  /\ InWorker /\ worker = "clean"
  /\ status' = [status EXCEPT ![next] = "worker"]
  /\ cleanAtAnswer' = [cleanAtAnswer EXCEPT ![next] = TRUE]
  /\ next' = next + 1
  /\ UNCHANGED <<worker, stopped, restarts>>

\* The trial, or an earlier one, changed the worker. The control fails: the mutation is left open for a fresh run.
\* The file continues in a new worker, or stops when its restarts are used up.
Stop ==
  /\ InWorker
  /\ status' = [status EXCEPT ![next] = "open"]
  /\ next' = next + 1
  /\ worker' = "clean"
  /\ restarts' = restarts + 1
  /\ stopped' = (restarts >= MaxRestarts)
  /\ UNCHANGED cleanAtAnswer

\* The trial never returns. The worker is replaced by a clean one.
Stuck ==
  /\ InWorker
  /\ status' = [status EXCEPT ![next] = "timeout"]
  /\ next' = next + 1
  /\ worker' = "clean"
  /\ UNCHANGED <<stopped, cleanAtAnswer, restarts>>

\* What the worker did not decide runs in a fresh Vitest run.
Fresh(m) ==
  /\ status[m] = "open" \/ (status[m] = "planned" /\ (stopped \/ next > Count))
  /\ status' = [status EXCEPT ![m] = "fresh"]
  /\ UNCHANGED <<next, worker, stopped, cleanAtAnswer, restarts>>

Next == Answer \/ Stop \/ Stuck \/ \E m \in Mutants : Fresh(m)

Spec == Init /\ [][Next]_<<status, next, worker, stopped, cleanAtAnswer, restarts>>
  /\ WF_<<status, next, worker, stopped, cleanAtAnswer, restarts>>(Next)

TypeOK == status \in [Mutants -> {"planned", "open"} \cup Final] /\ next \in 1..(Count + 1) /\ worker \in {"clean", "changed"}
  /\ restarts \in 0..(MaxRestarts + 1)

\* A verdict from the worker was always taken with a passed control.
WorkerVerdictsAreControlled == \A m \in Mutants : status[m] = "worker" => cleanAtAnswer[m]

\* After the file stopped, the worker decides nothing more.
StoppedWorkerIsSilent == stopped => \A m \in Mutants : m >= next => status[m] # "worker"

\* A final verdict is never replaced.
Stable == [][\A m \in Mutants : status[m] \in Final => status'[m] = status[m]]_<<status, next, worker, stopped, cleanAtAnswer, restarts>>

\* Every mutation ends with exactly one final verdict.
AllDecided == <>[](\A m \in Mutants : status[m] \in Final)
===============================================================================
