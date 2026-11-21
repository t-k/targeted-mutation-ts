------------------------ MODULE FallbackPublication ------------------------
EXTENDS Naturals, TLC

VARIABLES phase, legacy, modern, validSpans, candidates, published
vars == <<phase, legacy, modern, validSpans, candidates, published>>

Init ==
  /\ phase = "legacy"
  /\ legacy \in {"accept", "decorator", "reject"}
  /\ modern \in {"accept", "reject"}
  /\ validSpans \in BOOLEAN
  /\ candidates \in 0..2
  /\ published = 0

Next ==
  /\ CASE phase = "legacy" ->
          phase' = CASE legacy = "accept" -> "spans"
                     [] legacy = "decorator" -> "modern"
                     [] OTHER -> "diagnostic"
       [] phase = "modern" ->
          phase' = IF modern = "accept" THEN "spans" ELSE "diagnostic"
       [] phase = "spans" ->
          phase' = IF validSpans THEN "done" ELSE "diagnostic"
       [] OTHER -> FALSE
  /\ published' = IF phase' = "done" THEN candidates ELSE 0
  /\ UNCHANGED <<legacy, modern, validSpans, candidates>>

Spec == Init /\ [][Next]_vars

SelectiveRetry ==
  phase = "modern" => legacy = "decorator"

NoPartial ==
  IF phase = "done"
  THEN /\ validSpans
       /\ legacy = "accept" \/ (legacy = "decorator" /\ modern = "accept")
       /\ published = candidates
  ELSE published = 0
=============================================================================
