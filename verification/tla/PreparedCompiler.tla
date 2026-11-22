---------------------------- MODULE PreparedCompiler ----------------------------
EXTENDS TLC

VARIABLES entry, manifestMatches, decision, enabled, engineMatches, sourceMatches
vars == <<entry, manifestMatches, decision, enabled, engineMatches, sourceMatches>>
inputs == <<enabled, engineMatches, sourceMatches>>

Entries == {"absent", "old", "new"}

Init == /\ entry \in Entries \ {"new"}
        /\ manifestMatches \in BOOLEAN
        /\ decision = [kind |-> "pending", entry |-> "absent", manifest |-> FALSE]
        /\ enabled \in BOOLEAN
        /\ engineMatches \in BOOLEAN
        /\ sourceMatches \in BOOLEAN

ReplaceEntry == /\ entry # "new"
                /\ entry' = "new"
                /\ UNCHANGED <<manifestMatches, decision, inputs>>

PublishManifest == /\ entry = "new" /\ ~manifestMatches
                   /\ manifestMatches' = TRUE
                   /\ UNCHANGED <<entry, decision, inputs>>

\* Each load snapshots one cache entry. Node checks the source and engine on each cache hit.
Load == /\ decision.kind = "pending"
        /\ decision' = [kind |-> IF enabled /\ manifestMatches /\ engineMatches /\ sourceMatches /\ entry # "absent"
                                 THEN "prepared" ELSE "ordinary",
                         entry |-> entry, manifest |-> manifestMatches]
        /\ UNCHANGED <<entry, manifestMatches, inputs>>

Next == ReplaceEntry \/ PublishManifest \/ Load
Spec == Init /\ [][Next]_vars

SafeSelection == /\ decision.kind = "prepared" => enabled /\ decision.manifest /\ engineMatches /\ sourceMatches
                                                  /\ decision.entry # "absent"
                 /\ decision.kind \in {"pending", "prepared", "ordinary"}
=============================================================================
