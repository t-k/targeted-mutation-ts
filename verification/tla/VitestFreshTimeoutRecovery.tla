---- MODULE VitestFreshTimeoutRecovery ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS WarmIds, FreshIds

VARIABLES
  phase,          \* "in_worker" | "emit_warm" | "fresh_run" | "done" | "crashed"
  emitted,        \* [id -> "none" | "warm_ok" | "timeout" | "killed"]
  freshQueue,     \* sequence of fresh IDs still to evaluate
  activeFresh,    \* current fresh ID or "none"
  activeSeq,      \* monotonically increasing destination file sequence
  laneHealthy,    \* TRUE if current fresh lane is usable
  staleSeqs,      \* set of destination seqs owned by timed-out workers
  writtenSeqs,    \* set of destination seqs that received a write
  checkpointed    \* set of IDs persisted to checkpoint on session end

vars == <<phase, emitted, freshQueue, activeFresh, activeSeq, laneHealthy, staleSeqs, writtenSeqs, checkpointed>>

AllIds == WarmIds \cup FreshIds

TypeOK ==
  /\ phase \in {"in_worker", "emit_warm", "fresh_run", "done", "crashed"}
  /\ emitted \in [AllIds -> {"none", "warm_ok", "timeout", "killed"}]
  /\ activeFresh \in FreshIds \cup {"none"}
  /\ activeSeq \in Nat
  /\ laneHealthy \in BOOLEAN
  /\ staleSeqs \subseteq (0..10)
  /\ writtenSeqs \subseteq (0..10)
  /\ checkpointed \subseteq AllIds

Init ==
  /\ phase = "in_worker"
  /\ emitted = [id \in AllIds |-> "none"]
  /\ freshQueue = <<"f1", "f2">>
  /\ activeFresh = "none"
  /\ activeSeq = 0
  /\ laneHealthy = FALSE
  /\ staleSeqs = {}
  /\ writtenSeqs = {}
  /\ checkpointed = {}

FinishInWorker ==
  /\ phase = "in_worker"
  /\ phase' = "emit_warm"
  /\ UNCHANGED <<emitted, freshQueue, activeFresh, activeSeq, laneHealthy, staleSeqs, writtenSeqs, checkpointed>>

PersistWarmResults ==
  /\ phase = "emit_warm"
  /\ emitted' = [id \in AllIds |-> IF id \in WarmIds THEN "warm_ok" ELSE emitted[id]]
  /\ phase' = "fresh_run"
  /\ UNCHANGED <<freshQueue, activeFresh, activeSeq, laneHealthy, staleSeqs, writtenSeqs, checkpointed>>

StartFreshTrial ==
  /\ phase = "fresh_run"
  /\ activeFresh = "none"
  /\ Len(freshQueue) > 0
  /\ activeFresh' = Head(freshQueue)
  /\ freshQueue' = Tail(freshQueue)
  /\ activeSeq' = activeSeq + 1
  /\ laneHealthy' = TRUE
  /\ UNCHANGED <<phase, emitted, staleSeqs, writtenSeqs, checkpointed>>

FreshTrialSucceeds ==
  /\ phase = "fresh_run"
  /\ activeFresh # "none"
  /\ laneHealthy
  /\ emitted' = [emitted EXCEPT ![activeFresh] = "killed"]
  /\ writtenSeqs' = writtenSeqs \cup {activeSeq}
  /\ activeFresh' = "none"
  /\ UNCHANGED <<phase, freshQueue, activeSeq, laneHealthy, staleSeqs, checkpointed>>

FreshTrialTimesOut ==
  /\ phase = "fresh_run"
  /\ activeFresh # "none"
  /\ emitted' = [emitted EXCEPT ![activeFresh] = "timeout"]
  /\ staleSeqs' = staleSeqs \cup {activeSeq}
  /\ laneHealthy' = FALSE
  /\ activeFresh' = "none"
  /\ UNCHANGED <<phase, freshQueue, activeSeq, writtenSeqs, checkpointed>>

StaleWorkerLateWrite ==
  /\ staleSeqs # {}
  /\ \E s \in staleSeqs :
       /\ s # activeSeq
       /\ writtenSeqs' = writtenSeqs \cup {s}
  /\ UNCHANGED <<phase, emitted, freshQueue, activeFresh, activeSeq, laneHealthy, staleSeqs, checkpointed>>

CompleteSession ==
  /\ phase = "fresh_run"
  /\ activeFresh = "none"
  /\ Len(freshQueue) = 0
  /\ phase' = "done"
  /\ checkpointed' = {id \in AllIds : emitted[id] # "none"}
  /\ UNCHANGED <<emitted, freshQueue, activeFresh, activeSeq, laneHealthy, staleSeqs, writtenSeqs>>

ExternalCrashDuringFresh ==
  /\ phase = "fresh_run"
  /\ phase' = "crashed"
  /\ checkpointed' = {id \in AllIds : emitted[id] # "none"}
  /\ UNCHANGED <<emitted, freshQueue, activeFresh, activeSeq, laneHealthy, staleSeqs, writtenSeqs>>

Next ==
  \/ FinishInWorker
  \/ PersistWarmResults
  \/ StartFreshTrial
  \/ FreshTrialSucceeds
  \/ FreshTrialTimesOut
  \/ StaleWorkerLateWrite
  \/ CompleteSession
  \/ ExternalCrashDuringFresh

Spec == Init /\ [][Next]_vars

\* Invariant 1: Warm settled results are always emitted before any fresh trial begins.
WarmPersistedBeforeFresh ==
  (activeFresh # "none" \/ phase \in {"done", "crashed"}) =>
    \A id \in WarmIds : emitted[id] = "warm_ok"

\* Invariant 2: Active trial destination seq is never in staleSeqs (no late-write collision).
NoCrossTrialDestinationCollision ==
  activeFresh # "none" => activeSeq \notin staleSeqs

\* Invariant 3: On completion, every warm and fresh mutant has a definitive verdict (timeout does not abort remaining queue).
CompleteCoversAllMutants ==
  phase = "done" => \A id \in AllIds : emitted[id] # "none"

\* Invariant 4: Even on external crash during fresh phase, all warm results are preserved in checkpoint.
CrashPreservesWarm ==
  phase = "crashed" => WarmIds \subseteq checkpointed

====
