---------------------------- MODULE PreparedCompiler ----------------------------
EXTENDS TLC

VARIABLES stage, published, available, selected, registered,
          enabled, supported, matchingEngine, matchingSource, completeEntry
vars == <<stage, published, available, selected, registered,
          enabled, supported, matchingEngine, matchingSource, completeEntry>>
inputs == <<enabled, supported, matchingEngine, matchingSource, completeEntry>>

Init == /\ stage = "build"
        /\ published = "previous"
        /\ available \in BOOLEAN
        /\ enabled \in BOOLEAN
        /\ supported \in BOOLEAN
        /\ matchingEngine \in BOOLEAN
        /\ matchingSource \in BOOLEAN
        /\ completeEntry \in BOOLEAN
        /\ selected = "pending"
        /\ registered = "absent"

Publish(success) ==
  /\ stage = "build"
  /\ stage' = "load"
  /\ published' = IF success THEN "complete" ELSE published
  /\ available' = (available \/ success)
  /\ UNCHANGED <<selected, registered, inputs>>

Load ==
  /\ stage = "load"
  /\ LET usePrepared == available /\ enabled /\ supported /\ matchingEngine /\ matchingSource /\ completeEntry
     IN /\ stage' = IF usePrepared THEN "initialize" ELSE "done"
        /\ selected' = IF usePrepared THEN "prepared" ELSE "ordinary"
        /\ registered' = IF usePrepared THEN "loading" ELSE "absent"
  /\ UNCHANGED <<available, published, inputs>>

Initialize(success) ==
  /\ stage = "initialize"
  /\ stage' = IF success THEN "done" ELSE "failed"
  /\ registered' = IF success THEN "loaded" ELSE "absent"
  /\ UNCHANGED <<available, published, selected, inputs>>

Next == Publish(TRUE) \/ Publish(FALSE) \/ Load \/ Initialize(TRUE) \/ Initialize(FALSE)
Spec == Init /\ [][Next]_vars

Publication == /\ published \in {"previous", "complete"}
               /\ published = "complete" => available
SafeSelection == /\ selected = "prepared" => available /\ enabled /\ supported
                                            /\ matchingEngine /\ matchingSource /\ completeEntry
                 /\ stage = "done" => selected \in {"prepared", "ordinary"}
ModuleLifetime == /\ (registered = "loading") <=> (stage = "initialize")
                  /\ (registered = "loaded") <=> (stage = "done" /\ selected = "prepared")
                  /\ stage = "failed" => registered = "absent"
=============================================================================
