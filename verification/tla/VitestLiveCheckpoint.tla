---- MODULE VitestLiveCheckpoint ----
EXTENDS Naturals, FiniteSets

\* m1: warm settled (not sampled)
\* m2: warm settled (sampled for verification -> must stay pending until fresh completes)
\* m3: needs isolated fallback
Mutants == {"m1", "m2", "m3"}

VARIABLES
  phase,
  sessionLog,
  checkpoint,
  isolatedProgressEmitted,
  resumed,
  reused

vars == <<phase, sessionLog, checkpoint, isolatedProgressEmitted, resumed, reused>>

TypeOK ==
  /\ phase \in {"baseline", "warm", "isolated", "interrupted", "done"}
  /\ sessionLog \subseteq Mutants
  /\ checkpoint \subseteq Mutants
  /\ isolatedProgressEmitted \in BOOLEAN
  /\ resumed \in BOOLEAN
  /\ reused \subseteq Mutants

Init ==
  /\ phase = "baseline"
  /\ sessionLog = {}
  /\ checkpoint = {}
  /\ isolatedProgressEmitted = FALSE
  /\ resumed = FALSE
  /\ reused = {}

BaselinePassed ==
  /\ phase = "baseline"
  /\ phase' = "warm"
  /\ UNCHANGED <<sessionLog, checkpoint, isolatedProgressEmitted, resumed, reused>>

\* Session finishes warm phase: writes non-sampled settled warm verdict (m1) to sessionLog
\* before entering isolated fallback. m2 (sampled) stays pending.
FinishWarm ==
  /\ phase = "warm"
  /\ sessionLog' = sessionLog \cup ({"m1"} \ reused)
  /\ phase' = "isolated"
  /\ UNCHANGED <<checkpoint, isolatedProgressEmitted, resumed, reused>>

\* Parent poll syncs any completed sessionLog entries to durable checkpoint BEFORE emitting isolated progress.
ParentSyncAndEmitIsolatedProgress ==
  /\ phase = "isolated"
  /\ ~isolatedProgressEmitted
  /\ checkpoint' = checkpoint \cup sessionLog
  /\ isolatedProgressEmitted' = TRUE
  /\ UNCHANGED <<phase, sessionLog, resumed, reused>>

\* Isolated trial finishes for m2 or m3 and parent syncs it.
FinishFreshTrial(m) ==
  /\ phase = "isolated"
  /\ m \in ({"m2", "m3"} \ reused)
  /\ m \notin sessionLog
  /\ sessionLog' = sessionLog \cup {m}
  /\ checkpoint' = checkpoint \cup {m}
  /\ UNCHANGED <<phase, isolatedProgressEmitted, resumed, reused>>

\* Operator sends SIGINT during isolated fallback: before temp dir cleanup, parent flushes sessionLog to checkpoint.
InterruptDuringIsolated ==
  /\ phase = "isolated"
  /\ ~resumed
  /\ checkpoint' = checkpoint \cup sessionLog
  /\ sessionLog' = {}
  /\ phase' = "interrupted"
  /\ UNCHANGED <<isolatedProgressEmitted, resumed, reused>>

\* Operator resumes with the same checkpoint file.
ResumeFromCheckpoint ==
  /\ phase = "interrupted"
  /\ ~resumed
  /\ reused' = checkpoint
  /\ resumed' = TRUE
  /\ isolatedProgressEmitted' = FALSE
  /\ phase' = "baseline"
  /\ UNCHANGED <<sessionLog, checkpoint>>

\* All non-reused mutants are in sessionLog -> complete campaign.
CompleteCampaign ==
  /\ phase = "isolated"
  /\ (Mutants \ reused) \subseteq sessionLog
  /\ checkpoint' = checkpoint \cup sessionLog
  /\ phase' = "done"
  /\ UNCHANGED <<sessionLog, isolatedProgressEmitted, resumed, reused>>

Next ==
  \/ BaselinePassed
  \/ FinishWarm
  \/ ParentSyncAndEmitIsolatedProgress
  \/ \E m \in {"m2", "m3"}: FinishFreshTrial(m)
  \/ InterruptDuringIsolated
  \/ ResumeFromCheckpoint
  \/ CompleteCampaign
  \/ (phase = "done" /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

WarmPersistedBeforeIsolatedProgress ==
  isolatedProgressEmitted => ("m1" \in checkpoint)

SampledNotPersistedBeforeFresh ==
  ("m2" \notin reused /\ (phase \in {"baseline", "warm"} \/ (phase = "isolated" /\ "m2" \notin sessionLog)))
    => ("m2" \notin checkpoint)

InterruptPreservesWarm ==
  (phase = "interrupted" /\ isolatedProgressEmitted) => ("m1" \in checkpoint)

ResumeCompleteCoversAll ==
  (phase = "done") => (checkpoint = Mutants)

====
