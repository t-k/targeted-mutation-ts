---- MODULE UndoChangesFallback ----
EXTENDS Naturals

VARIABLES
  step,           \* 0..2 individual hunks, 3 = decide together, 4 = done
  hunk1,          \* "pending" | "killed" | "survived" | "unsupported" | "load_error" | "error"
  hunk2,          \* "pending" | "killed" | "survived" | "unsupported" | "load_error" | "error"
  togetherRun,    \* "none" | "killed" | "survived" | "unsupported" | "load_error" | "error"
  evaluation      \* "pending" | "evaluated" | "incomplete"

vars == <<step, hunk1, hunk2, togetherRun, evaluation>>

Outcomes == {"killed", "survived", "unsupported", "load_error", "error"}

Init ==
  /\ step = 0
  /\ hunk1 = "pending"
  /\ hunk2 = "pending"
  /\ togetherRun = "none"
  /\ evaluation = "pending"

RunHunk1 ==
  /\ step = 0
  /\ \E out \in Outcomes : hunk1' = out
  /\ step' = 1
  /\ UNCHANGED <<hunk2, togetherRun, evaluation>>

RunHunk2 ==
  /\ step = 1
  /\ \E out \in Outcomes : hunk2' = out
  /\ step' = 2
  /\ UNCHANGED <<hunk1, togetherRun, evaluation>>

NeedsTogether ==
  hunk1 \in {"unsupported", "load_error"} \/ hunk2 \in {"unsupported", "load_error"}

DecideTogether ==
  /\ step = 2
  /\ IF NeedsTogether
     THEN \E out \in Outcomes : togetherRun' = out
     ELSE togetherRun' = "none"
  /\ step' = 3
  /\ UNCHANGED <<hunk1, hunk2, evaluation>>

Finalize ==
  /\ step = 3
  /\ evaluation' = IF hunk1 = "error" \/ hunk2 = "error" \/ togetherRun = "error"
                   THEN "incomplete"
                   ELSE "evaluated"
  /\ step' = 4
  /\ UNCHANGED <<hunk1, hunk2, togetherRun>>

Next ==
  \/ RunHunk1
  \/ RunHunk2
  \/ DecideTogether
  \/ Finalize

TogetherRunsIffNeeded ==
  step >= 3 => ((togetherRun /= "none") <=> NeedsTogether)

LoadErrorNeverIncompleteAlone ==
  (step = 4 /\ hunk1 /= "error" /\ hunk2 /= "error" /\ togetherRun /= "error") => evaluation = "evaluated"

Spec == Init /\ [][Next]_vars

====
