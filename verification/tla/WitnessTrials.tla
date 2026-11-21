------------------------ MODULE WitnessTrials ------------------------
EXTENDS TLC

CONSTANT Pair
VARIABLES baseline, combined, first, second, original, mutated, attributed, published
vars == <<baseline, combined, first, second, original, mutated, attributed, published>>

Init ==
  /\ baseline = "pending"
  /\ combined = "pending"
  /\ first = "pending"
  /\ second = "pending"
  /\ original = "pending"
  /\ mutated = "pending"
  /\ attributed = FALSE
  /\ published = FALSE

Base ==
  /\ baseline = "pending"
  /\ baseline' \in {"passed", "error"}
  /\ UNCHANGED <<combined, first, second, original, mutated, attributed, published>>

Combined ==
  /\ baseline = "passed"
  /\ combined = "pending"
  /\ combined' \in {"survived", "killed", "error"}
  /\ UNCHANGED <<baseline, first, second, original, mutated, attributed, published>>

Singletons ==
  /\ Pair
  /\ combined = "survived"
  /\ first = "pending"
  /\ first' \in {"killed-by-seed", "killed", "survived", "error"}
  /\ second' \in {"killed-by-seed", "killed", "survived", "error"}
  /\ UNCHANGED <<baseline, combined, original, mutated, attributed, published>>

Ready == combined = "survived" /\ (~Pair \/ (first = "killed-by-seed" /\ second = "killed-by-seed"))

Original ==
  /\ Ready
  /\ original = "pending"
  /\ original' \in {"passed", "error"}
  /\ UNCHANGED <<baseline, combined, first, second, mutated, attributed, published>>

Mutated ==
  /\ original = "passed"
  /\ mutated = "pending"
  /\ mutated' \in {"failed", "passed", "error"}
  /\ attributed' \in BOOLEAN
  /\ UNCHANGED <<baseline, combined, first, second, original, published>>

Publish ==
  /\ mutated = "failed"
  /\ attributed
  /\ published' = TRUE
  /\ UNCHANGED <<baseline, combined, first, second, original, mutated, attributed>>

Spec == Init /\ [][Base \/ Combined \/ Singletons \/ Original \/ Mutated \/ Publish]_vars
ConfirmedEvidence == published => baseline = "passed" /\ Ready /\ original = "passed" /\ mutated = "failed" /\ attributed
=============================================================================
