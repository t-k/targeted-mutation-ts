---- MODULE CopyReuseLifecycle ----
EXTENDS Naturals, FiniteSets

CONSTANTS MaxConsumers

VARIABLES
  phase,
  dirExists,
  registered,
  claimedCount,
  disposed,
  signalReceived,
  exitCode

vars == <<phase, dirExists, registered, claimedCount, disposed, signalReceived, exitCode>>

Phases == {
  "Idle",
  "RelatedResolving",
  "ReadyForTransfer",
  "ClaimedRunning",
  "Done",
  "Failed",
  "Terminated"
}

TypeOK ==
  /\ phase \in Phases
  /\ dirExists \in BOOLEAN
  /\ registered \in BOOLEAN
  /\ claimedCount \in 0..MaxConsumers
  /\ disposed \in BOOLEAN
  /\ signalReceived \in {"None", "SIGINT", "SIGTERM"}
  /\ exitCode \in {0, 1, 130, 143}

Init ==
  /\ phase = "Idle"
  /\ dirExists = FALSE
  /\ registered = FALSE
  /\ claimedCount = 0
  /\ disposed = FALSE
  /\ signalReceived = "None"
  /\ exitCode = 0

CreateCopyForRelated ==
  /\ phase = "Idle"
  /\ phase' = "RelatedResolving"
  /\ dirExists' = TRUE
  /\ registered' = TRUE
  /\ UNCHANGED <<claimedCount, disposed, signalReceived, exitCode>>

RelatedSucceeded ==
  /\ phase = "RelatedResolving"
  /\ signalReceived = "None"
  /\ phase' = "ReadyForTransfer"
  /\ UNCHANGED <<dirExists, registered, claimedCount, disposed, signalReceived, exitCode>>

\* Discovery mutated the workspace tree: dispose the dirty copy so analysis allocates a fresh clean copy.
RelatedDirtyDiscarded ==
  /\ phase = "RelatedResolving"
  /\ signalReceived = "None"
  /\ phase' = "Done"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ disposed' = TRUE
  /\ exitCode' = 0
  /\ UNCHANGED <<claimedCount, signalReceived>>

RelatedFailedOrDisjoint ==
  /\ phase \in {"RelatedResolving", "ReadyForTransfer"}
  /\ signalReceived = "None"
  /\ phase' = "Failed"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ disposed' = TRUE
  /\ exitCode' = 1
  /\ UNCHANGED <<claimedCount, signalReceived>>

\* No consumer claimed the copy (e.g. no_sites, all checkpoint hits, --audit, --witnesses) -> caller finally disposes it.
CallerFinallyDisposesUnclaimed ==
  /\ phase = "ReadyForTransfer"
  /\ claimedCount = 0
  /\ signalReceived = "None"
  /\ phase' = "Done"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ disposed' = TRUE
  /\ exitCode' = 0
  /\ UNCHANGED <<claimedCount, signalReceived>>

\* Exactly one consumer may claim the reusable copy.
ClaimByConsumer ==
  /\ phase = "ReadyForTransfer"
  /\ claimedCount = 0
  /\ ~disposed
  /\ signalReceived = "None"
  /\ phase' = "ClaimedRunning"
  /\ claimedCount' = 1
  /\ UNCHANGED <<dirExists, registered, disposed, signalReceived, exitCode>>

\* A second consumer attempting claim() sees claimedCount = 1 and falls back to its own copy (does not mutate this handle).
SecondClaimRejected ==
  /\ phase \in {"ClaimedRunning", "Done", "Failed"}
  /\ claimedCount = 1
  /\ UNCHANGED vars

ConsumerFinished ==
  /\ phase = "ClaimedRunning"
  /\ signalReceived = "None"
  /\ phase' = "Done"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ disposed' = TRUE
  /\ exitCode' = 0
  /\ UNCHANGED <<claimedCount, signalReceived>>

ConsumerFailed ==
  /\ phase = "ClaimedRunning"
  /\ signalReceived = "None"
  /\ phase' = "Failed"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ disposed' = TRUE
  /\ exitCode' = 1
  /\ UNCHANGED <<claimedCount, signalReceived>>

ReceiveSignal(sig) ==
  /\ sig \in {"SIGINT", "SIGTERM"}
  /\ phase \in {"RelatedResolving", "ReadyForTransfer", "ClaimedRunning"}
  /\ signalReceived = "None"
  /\ signalReceived' = sig
  /\ phase' = "Terminated"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ disposed' = TRUE
  /\ exitCode' = IF sig = "SIGINT" THEN 130 ELSE 143
  /\ UNCHANGED <<claimedCount>>

\* Idempotent dispose() from caller finally after consumer already disposed.
IdempotentDispose ==
  /\ disposed
  /\ phase \in {"Done", "Failed", "Terminated"}
  /\ UNCHANGED vars

Next ==
  \/ CreateCopyForRelated
  \/ RelatedSucceeded
  \/ RelatedDirtyDiscarded
  \/ RelatedFailedOrDisjoint
  \/ CallerFinallyDisposesUnclaimed
  \/ ClaimByConsumer
  \/ SecondClaimRejected
  \/ ConsumerFinished
  \/ ConsumerFailed
  \/ ReceiveSignal("SIGINT")
  \/ ReceiveSignal("SIGTERM")
  \/ IdempotentDispose

Spec == Init /\ [][Next]_vars

\* Safety 1: No temporary directory leak in any terminal state.
NoLeakedTempDir ==
  phase \in {"Done", "Failed", "Terminated"} => (~dirExists /\ ~registered /\ disposed)

\* Safety 2: At most one consumer can ever claim a copy handle (prevents concurrent mutation corruption).
SingleConsumerOwnership ==
  claimedCount <= 1

\* Safety 3: Active directory is always registered for signal cleanup.
ActiveDirAlwaysRegistered ==
  dirExists => registered

\* Safety 4: Signal exit codes match POSIX conventions.
SignalExitCodeMatches ==
  /\ (signalReceived = "SIGINT" => exitCode = 130)
  /\ (signalReceived = "SIGTERM" => exitCode = 143)

====
