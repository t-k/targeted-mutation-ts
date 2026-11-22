----------------------------- MODULE ScopePatchRetry -----------------------------
EXTENDS FiniteSets

CONSTANT Files
VARIABLES phase, individual, ranges, published
vars == <<phase, individual, ranges, published>>

\* A fixed Git view supplies the ranges for each file. The model checks retry
\* and publication, independent of pathname quoting and hunk decoding.
Init == /\ phase = "memory"
        /\ individual = {}
        /\ ranges \in [Files -> BOOLEAN]
        /\ published = [file \in {} |-> FALSE]

Success == /\ phase \in {"memory", "spool"}
           /\ phase' = "done"
           /\ published' = ranges
           /\ UNCHANGED <<individual, ranges>>

Overflow == /\ phase = "memory"
            /\ phase' = "spool"
            /\ UNCHANGED <<individual, ranges, published>>

Unmapped == /\ phase \in {"memory", "spool"}
            /\ phase' = "individual"
            /\ UNCHANGED <<individual, ranges, published>>

ReadOne == /\ phase = "individual"
           /\ \E file \in Files \ individual: individual' = individual \cup {file}
           /\ UNCHANGED <<phase, ranges, published>>

Finish == /\ phase = "individual"
          /\ individual = Files
          /\ phase' = "done"
          /\ published' = [file \in individual |-> ranges[file]]
          /\ UNCHANGED <<individual, ranges>>

Failure == /\ phase \in {"memory", "spool", "individual"}
           /\ phase' = "failed"
           /\ UNCHANGED <<individual, ranges, published>>

Next == Success \/ Overflow \/ Unmapped \/ ReadOne \/ Finish \/ Failure
Spec == Init /\ [][Next]_vars
NoPartialPublication == phase # "done" => DOMAIN published = {}
CompleteRanges == phase = "done" => published = ranges
===============================================================================
