---- MODULE CampaignCheckpoint ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Candidates, Contexts

VARIABLES
  ctx,          \* Current campaign context
  logCtx,       \* Context recorded in checkpoint file (0 = none)
  stored,       \* Function: candidate -> outcome (0 = none, 1 = killed, 2 = survived)
  corruptedTail,\* Boolean: whether a simulated crash left a partial trailing line
  done,         \* Set of candidates completed in current run
  staleLeak     \* Boolean: true if an outcome from a different context was ever reused

vars == <<ctx, logCtx, stored, corruptedTail, done, staleLeak>>

Outcomes == {1, 2}

Init ==
  /\ ctx \in Contexts
  /\ logCtx = 0
  /\ stored = [c \in Candidates |-> 0]
  /\ corruptedTail = FALSE
  /\ done = {}
  /\ staleLeak = FALSE

\* Start or resume a campaign with a possibly new context
StartCampaign(newCtx) ==
  /\ newCtx \in Contexts
  /\ ctx' = newCtx
  /\ IF logCtx = newCtx THEN
       \* Context matches: recover any corrupted tail (discard partial line) and reuse stored outcomes
       /\ corruptedTail' = FALSE
       /\ logCtx' = logCtx
       /\ stored' = stored
       /\ done' = {c \in Candidates : stored[c] # 0}
       /\ staleLeak' = staleLeak
     ELSE
       \* Context differs or empty: reset checkpoint cleanly
       /\ corruptedTail' = FALSE
       /\ logCtx' = newCtx
       /\ stored' = [c \in Candidates |-> 0]
       /\ done' = {}
       /\ staleLeak' = staleLeak

\* Record a completed candidate outcome atomically
RecordOutcome(c, out) ==
  /\ c \in Candidates \ done
  /\ out \in Outcomes
  /\ logCtx = ctx
  /\ ~corruptedTail
  /\ stored' = [stored EXCEPT ![c] = out]
  /\ done' = done \cup {c}
  /\ UNCHANGED <<ctx, logCtx, corruptedTail, staleLeak>>

\* Simulate a crash mid-write (leaves a corrupted trailing line, prior stored outcomes remain intact)
CrashMidWrite ==
  /\ logCtx = ctx
  /\ done # Candidates
  /\ corruptedTail' = TRUE
  /\ UNCHANGED <<ctx, logCtx, stored, done, staleLeak>>

Next ==
  \/ \E newCtx \in Contexts : StartCampaign(newCtx)
  \/ \E c \in Candidates, out \in Outcomes : RecordOutcome(c, out)
  \/ CrashMidWrite

TypeOK ==
  /\ ctx \in Contexts
  /\ logCtx \in Contexts \cup {0}
  /\ \A c \in Candidates : stored[c] \in {0, 1, 2}
  /\ corruptedTail \in BOOLEAN
  /\ done \subseteq Candidates
  /\ staleLeak \in BOOLEAN

\* Core safety invariants:
\* 1. Never reuse an outcome from a mismatched context
NoStaleLeak == ~staleLeak
\* 2. Every done candidate has a valid recorded outcome in the matching context
DoneMatchesStored ==
  (logCtx = ctx) => (\A c \in done : stored[c] \in Outcomes)
\* 3. When logCtx /= ctx, no candidate is marked done until StartCampaign resets
CleanBoundary ==
  (logCtx # ctx) => (done = {})

Spec == Init /\ [][Next]_vars
====
