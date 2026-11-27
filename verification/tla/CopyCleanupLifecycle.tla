---- MODULE CopyCleanupLifecycle ----
EXTENDS Naturals, FiniteSets

CONSTANTS MaxCopies

VARIABLES
  phase,
  dirExists,
  registered,
  signalReceived,
  cleanupCalls,
  exitCode

vars == <<phase, dirExists, registered, signalReceived, cleanupCalls, exitCode>>

Phases == {"Idle", "Copying", "RunningSync", "RunningAsync", "Done", "Failed", "Terminated"}

TypeOK ==
  /\ phase \in Phases
  /\ dirExists \in BOOLEAN
  /\ registered \in BOOLEAN
  /\ signalReceived \in {"None", "SIGINT", "SIGTERM"}
  /\ cleanupCalls \in 0..MaxCopies
  /\ exitCode \in {0, 1, 130, 143}

Init ==
  /\ phase = "Idle"
  /\ dirExists = FALSE
  /\ registered = FALSE
  /\ signalReceived = "None"
  /\ cleanupCalls = 0
  /\ exitCode = 0

CreateTempDir ==
  /\ phase = "Idle"
  /\ phase' = "Copying"
  /\ dirExists' = TRUE
  /\ registered' = TRUE
  /\ UNCHANGED <<signalReceived, cleanupCalls, exitCode>>

StartSync ==
  /\ phase = "Copying"
  /\ signalReceived = "None"
  /\ phase' = "RunningSync"
  /\ UNCHANGED <<dirExists, registered, signalReceived, cleanupCalls, exitCode>>

StartAsync ==
  /\ phase = "Copying"
  /\ signalReceived = "None"
  /\ phase' = "RunningAsync"
  /\ UNCHANGED <<dirExists, registered, signalReceived, cleanupCalls, exitCode>>

FinishNormal ==
  /\ phase \in {"RunningSync", "RunningAsync"}
  /\ signalReceived = "None"
  /\ phase' = "Done"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ cleanupCalls' = IF cleanupCalls < MaxCopies THEN cleanupCalls + 1 ELSE cleanupCalls
  /\ exitCode' = 0
  /\ UNCHANGED <<signalReceived>>

FinishError ==
  /\ phase \in {"Copying", "RunningSync", "RunningAsync"}
  /\ signalReceived = "None"
  /\ phase' = "Failed"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ cleanupCalls' = IF cleanupCalls < MaxCopies THEN cleanupCalls + 1 ELSE cleanupCalls
  /\ exitCode' = 1
  /\ UNCHANGED <<signalReceived>>

ReceiveSignal(sig) ==
  /\ sig \in {"SIGINT", "SIGTERM"}
  /\ phase \in {"Copying", "RunningSync", "RunningAsync"}
  /\ signalReceived = "None"
  /\ signalReceived' = sig
  /\ phase' = "Terminated"
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ cleanupCalls' = IF cleanupCalls < MaxCopies THEN cleanupCalls + 1 ELSE cleanupCalls
  /\ exitCode' = IF sig = "SIGINT" THEN 130 ELSE 143

DuplicateSignalOrExitCleanup ==
  /\ phase \in {"Done", "Failed", "Terminated"}
  /\ dirExists' = FALSE
  /\ registered' = FALSE
  /\ cleanupCalls' = IF cleanupCalls < MaxCopies THEN cleanupCalls + 1 ELSE cleanupCalls
  /\ UNCHANGED <<phase, signalReceived, exitCode>>

Next ==
  \/ CreateTempDir
  \/ StartSync
  \/ StartAsync
  \/ FinishNormal
  \/ FinishError
  \/ ReceiveSignal("SIGINT")
  \/ ReceiveSignal("SIGTERM")
  \/ DuplicateSignalOrExitCleanup

Spec == Init /\ [][Next]_vars

\* Safety: Once in any terminal phase, the temporary directory never remains on disk and is unregistered.
NoLeakedTempDir ==
  phase \in {"Done", "Failed", "Terminated"} => (~dirExists /\ ~registered)

\* Safety: Signal termination always maps to standard POSIX signal exit code (130 / 143).
SignalExitCodeMatches ==
  /\ (signalReceived = "SIGINT" => exitCode = 130)
  /\ (signalReceived = "SIGTERM" => exitCode = 143)

\* Safety: Active temp directory is always tracked in the registry so signal handlers can clean it.
ActiveDirAlwaysRegistered ==
  dirExists => registered

====
