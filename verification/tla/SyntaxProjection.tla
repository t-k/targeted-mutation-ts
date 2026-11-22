---------------------------- MODULE SyntaxProjection ----------------------------
EXTENDS TLC

VARIABLES file, fullLoaded, step, used, output, versionMatches, succeeds
vars == <<file, fullLoaded, step, used, output, versionMatches, succeeds>>
inputs == <<versionMatches, succeeds>>

Init == /\ file \in {"absent", "invalid", "complete"}
        /\ fullLoaded \in BOOLEAN
        /\ versionMatches \in BOOLEAN
        /\ succeeds \in BOOLEAN
        /\ step = "select"
        /\ used = "none"
        /\ output = "none"

Publish == /\ file # "complete"
           /\ file' = "complete"
           /\ UNCHANGED <<fullLoaded, step, used, output, inputs>>

Select == /\ step = "select"
          /\ used' = IF ~fullLoaded /\ file = "complete" /\ versionMatches THEN "syntax" ELSE "full"
          /\ step' = "parse"
          /\ UNCHANGED <<file, fullLoaded, output, inputs>>

Execute == /\ step = "parse"
           /\ IF used = "syntax" /\ ~succeeds
              THEN /\ used' = "full" /\ UNCHANGED <<step, fullLoaded, output>>
              ELSE /\ step' = "done" /\ output' = used /\ fullLoaded' = (used = "full") /\ UNCHANGED used
           /\ UNCHANGED <<file, inputs>>

Next == Publish \/ Select \/ Execute
Spec == Init /\ [][Next]_vars

NoPartialPublication == step # "done" => output = "none"
CompleteSyntax == output = "syntax" => file = "complete" /\ versionMatches /\ succeeds /\ ~fullLoaded
Fallback == step = "done" => output = "syntax" \/ (output = "full" /\ fullLoaded)
=============================================================================
