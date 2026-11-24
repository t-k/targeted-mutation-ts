---- MODULE SessionExtrasLifecycle ----
EXTENDS Naturals

VARIABLES
  tempState,     \* "live" | "removed"
  sessionState,  \* "running" | "exited" | "aborted"
  prepareState,  \* "running" | "resolved" | "failed"
  extrasState,   \* "pending" | "written" | "skipped"
  writeViolation \* BOOLEAN

vars == <<tempState, sessionState, prepareState, extrasState, writeViolation>>

Init ==
  /\ tempState = "live"
  /\ sessionState = "running"
  /\ prepareState = "running"
  /\ extrasState = "pending"
  /\ writeViolation = FALSE

PrepareResolves ==
  /\ prepareState = "running"
  /\ prepareState' = "resolved"
  /\ UNCHANGED <<tempState, sessionState, extrasState, writeViolation>>

PrepareFails ==
  /\ prepareState = "running"
  /\ prepareState' = "failed"
  /\ sessionState' = IF sessionState = "running" THEN "aborted" ELSE sessionState
  /\ UNCHANGED <<tempState, extrasState, writeViolation>>

SessionExits ==
  /\ sessionState \in {"running", "aborted"}
  /\ sessionState' = "exited"
  /\ tempState' = "removed"
  /\ UNCHANGED <<prepareState, extrasState, writeViolation>>

WriteExtrasGuarded ==
  /\ prepareState \in {"resolved", "failed"}
  /\ extrasState = "pending"
  /\ IF tempState = "live" /\ sessionState = "running"
     THEN /\ extrasState' = "written"
          /\ writeViolation' = writeViolation
     ELSE /\ extrasState' = "skipped"
          /\ writeViolation' = writeViolation
  /\ UNCHANGED <<tempState, sessionState, prepareState>>

Next ==
  \/ PrepareResolves
  \/ PrepareFails
  \/ SessionExits
  \/ WriteExtrasGuarded

NoWriteAfterTempRemoved == ~writeViolation

WrittenOnlyWhileLive ==
  (extrasState = "written" /\ sessionState = "running") => tempState = "live"

Spec == Init /\ [][Next]_vars

====
