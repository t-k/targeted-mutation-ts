---------------------- MODULE PlaywrightTargetedSession ----------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Tests, Mutants

None == "none"

VARIABLES
  stage,           \* "boot" | "baseline" | "trials" | "done"
  currentTest,     \* None or t \in Tests during baseline
  doneTests,       \* subset of Tests completed in baseline
  serverStatic,    \* [m \in Mutants -> BOOLEAN] hit during server boot
  serverReach,     \* [t \in Tests -> SUBSET Mutants]
  browserPending,  \* SUBSET Mutants in current browser document before binding flush
  browserFlushed,  \* [t \in Tests -> SUBSET Mutants] flushed via exposeBinding / frame harvest
  activeMutant,    \* None or m \in Mutants during warm trial
  trialStep,       \* "idle" | "trial" | "control"
  trialOutcome,    \* [m \in Mutants -> "none" | "pass" | "fail"]
  trialCorrupted,  \* BOOLEAN: whether the active trial mutated persistent server state
  serverDirty,     \* BOOLEAN: persistent webServer state is currently polluted
  settled,         \* [m \in Mutants -> "open" | "unreached" | "killed" | "survived"]
  settledVia       \* [m \in Mutants -> "none" | "coverage" | "warm" | "isolated"]

vars == <<
  stage, currentTest, doneTests, serverStatic, serverReach,
  browserPending, browserFlushed, activeMutant, trialStep,
  trialOutcome, trialCorrupted, serverDirty, settled, settledVia
>>

TotalReached(m) ==
  {t \in Tests : m \in serverReach[t] \/ m \in browserFlushed[t]}

Init ==
  /\ stage = "boot"
  /\ currentTest = None
  /\ doneTests = {}
  /\ serverStatic = [m \in Mutants |-> FALSE]
  /\ serverReach = [t \in Tests |-> {}]
  /\ browserPending = {}
  /\ browserFlushed = [t \in Tests |-> {}]
  /\ activeMutant = None
  /\ trialStep = "idle"
  /\ trialOutcome = [m \in Mutants |-> "none"]
  /\ trialCorrupted = FALSE
  /\ serverDirty = FALSE
  /\ settled = [m \in Mutants |-> "open"]
  /\ settledVia = [m \in Mutants |-> "none"]

\* Server module load before any test runs.
BootServerHit(m) ==
  /\ stage = "boot"
  /\ currentTest = None
  /\ serverStatic' = [serverStatic EXCEPT ![m] = TRUE]
  /\ UNCHANGED <<stage, currentTest, doneTests, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

FinishBoot ==
  /\ stage = "boot"
  /\ stage' = "baseline"
  /\ UNCHANGED <<currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

BeginBaselineTest(t) ==
  /\ stage = "baseline"
  /\ currentTest = None
  /\ t \notin doneTests
  /\ browserPending = {}
  /\ currentTest' = t
  /\ UNCHANGED <<stage, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

RecordServerHit(m) ==
  /\ stage = "baseline"
  /\ currentTest \in Tests
  /\ serverReach' = [serverReach EXCEPT ![currentTest] = @ \cup {m}]
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

RecordBrowserHit(m) ==
  /\ stage = "baseline"
  /\ currentTest \in Tests
  /\ browserPending' = browserPending \cup {m}
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

\* Browser navigation flushes pending document observations via exposeBinding/pagehide before new document loads.
BrowserNavigate ==
  /\ stage = "baseline"
  /\ currentTest \in Tests
  /\ browserFlushed' = [browserFlushed EXCEPT ![currentTest] = @ \cup browserPending]
  /\ browserPending' = {}
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

EndBaselineTest ==
  /\ stage = "baseline"
  /\ currentTest \in Tests
  /\ browserFlushed' = [browserFlushed EXCEPT ![currentTest] = @ \cup browserPending]
  /\ browserPending' = {}
  /\ doneTests' = doneTests \cup {currentTest}
  /\ currentTest' = None
  /\ UNCHANGED <<stage, serverStatic, serverReach,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

StartTrials ==
  /\ stage = "baseline"
  /\ currentTest = None
  /\ doneTests = Tests
  /\ stage' = "trials"
  /\ UNCHANGED <<currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

\* A mutant with zero server-boot, server-test, and browser-test hits is immediately settled as unreached.
MarkUnreached(m) ==
  /\ stage = "trials"
  /\ trialStep = "idle"
  /\ settled[m] = "open"
  /\ ~serverStatic[m]
  /\ TotalReached(m) = {}
  /\ settled' = [settled EXCEPT ![m] = "unreached"]
  /\ settledVia' = [settledVia EXCEPT ![m] = "coverage"]
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty>>

\* A server-static mutant cannot be toggled at request time; it must run in an isolated fresh server.
RunIsolatedServerStatic(m, outcome) ==
  /\ stage = "trials"
  /\ trialStep = "idle"
  /\ settled[m] = "open"
  /\ serverStatic[m]
  /\ outcome \in {"killed", "survived"}
  /\ settled' = [settled EXCEPT ![m] = outcome]
  /\ settledVia' = [settledVia EXCEPT ![m] = "isolated"]
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty>>

\* Warm trial run for a request/browser-scoped reached mutant.
StartWarmTrial(m, outcome, pollutes) ==
  /\ stage = "trials"
  /\ trialStep = "idle"
  /\ ~serverDirty
  /\ settled[m] = "open"
  /\ ~serverStatic[m]
  /\ TotalReached(m) /= {}
  /\ outcome \in {"pass", "fail"}
  /\ pollutes \in BOOLEAN
  /\ activeMutant' = m
  /\ trialStep' = "control"
  /\ trialOutcome' = [trialOutcome EXCEPT ![m] = outcome]
  /\ trialCorrupted' = pollutes
  /\ serverDirty' = (serverDirty \/ pollutes)
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 settled, settledVia>>

\* Post-trial control with activeMutant = None passes only when serverDirty is FALSE.
ControlPass ==
  /\ stage = "trials"
  /\ trialStep = "control"
  /\ activeMutant \in Mutants
  /\ ~serverDirty
  /\ LET m == activeMutant
         verdict == IF trialOutcome[m] = "fail" THEN "killed" ELSE "survived"
     IN /\ settled' = [settled EXCEPT ![m] = verdict]
        /\ settledVia' = [settledVia EXCEPT ![m] = "warm"]
  /\ activeMutant' = None
  /\ trialStep' = "idle"
  /\ trialCorrupted' = FALSE
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 trialOutcome, serverDirty>>

\* When post-trial control detects environment drift/pollution, discard warm verdict, restart clean server, and run isolated.
ControlFailAndFallback(isolatedVerdict) ==
  /\ stage = "trials"
  /\ trialStep = "control"
  /\ activeMutant \in Mutants
  /\ serverDirty
  /\ isolatedVerdict \in {"killed", "survived"}
  /\ LET m == activeMutant
     IN /\ settled' = [settled EXCEPT ![m] = isolatedVerdict]
        /\ settledVia' = [settledVia EXCEPT ![m] = "isolated"]
  /\ activeMutant' = None
  /\ trialStep' = "idle"
  /\ trialCorrupted' = FALSE
  /\ serverDirty' = FALSE
  /\ UNCHANGED <<stage, currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 trialOutcome>>

FinishCampaign ==
  /\ stage = "trials"
  /\ trialStep = "idle"
  /\ \A m \in Mutants : settled[m] /= "open"
  /\ stage' = "done"
  /\ UNCHANGED <<currentTest, doneTests, serverStatic, serverReach, browserPending, browserFlushed,
                 activeMutant, trialStep, trialOutcome, trialCorrupted, serverDirty, settled, settledVia>>

Next ==
  \/ \E m \in Mutants : BootServerHit(m)
  \/ FinishBoot
  \/ \E t \in Tests : BeginBaselineTest(t)
  \/ \E m \in Mutants : RecordServerHit(m)
  \/ \E m \in Mutants : RecordBrowserHit(m)
  \/ BrowserNavigate
  \/ EndBaselineTest
  \/ StartTrials
  \/ \E m \in Mutants : MarkUnreached(m)
  \/ \E m \in Mutants, v \in {"killed", "survived"} : RunIsolatedServerStatic(m, v)
  \/ \E m \in Mutants, o \in {"pass", "fail"}, p \in BOOLEAN : StartWarmTrial(m, o, p)
  \/ ControlPass
  \/ \E v \in {"killed", "survived"} : ControlFailAndFallback(v)
  \/ FinishCampaign

Spec == Init /\ [][Next]_vars

\* Invariants
SingleActiveOwner ==
  /\ currentTest \in Tests \cup {None}
  /\ (currentTest /= None) => (stage = "baseline" /\ activeMutant = None)
  /\ (browserPending /= {}) => (stage = "baseline" /\ currentTest \in Tests)

NoLostBrowserObservations ==
  (stage \in {"trials", "done"}) => (browserPending = {})

ServerStaticNeverWarm ==
  \A m \in Mutants : serverStatic[m] => (settledVia[m] \notin {"warm", "coverage"})

UnreachedIsTrulyUnreached ==
  \A m \in Mutants :
    (settled[m] = "unreached") => (~serverStatic[m] /\ TotalReached(m) = {})

CleanIdleServer ==
  (stage = "trials" /\ trialStep = "idle") => (~serverDirty /\ activeMutant = None)

AllSettledWhenDone ==
  (stage = "done") => (\A m \in Mutants : settled[m] \in {"unreached", "killed", "survived"})
=============================================================================
