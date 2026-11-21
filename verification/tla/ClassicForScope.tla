---------------------------- MODULE ClassicForScope ---------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Capacity
VARIABLES phase, header, body, active, candidate, published
vars == <<phase, header, body, active, candidate, published>>

Names == {"outer", "loop", "inner"}
Outer == {"outer"}
AsSet(names) == {names[i] : i \in DOMAIN names}
Unique(names) == Cardinality(AsSet(names)) = Len(names)

Init == /\ phase = "header"
        /\ header = <<>>
        /\ body = <<>>
        /\ active = Outer
        /\ candidate = FALSE
        /\ published = FALSE

HeaderName(name) ==
  /\ phase = "header"
  /\ Len(header) < Capacity
  /\ header' = Append(header, name)
  /\ phase' = IF name \in AsSet(header) THEN "failed" ELSE phase
  /\ active' = IF phase' = "failed" THEN Outer ELSE active \cup {name}
  /\ UNCHANGED <<body, candidate, published>>

BeginBody ==
  /\ phase = "header"
  /\ phase' = "body"
  /\ UNCHANGED <<header, body, active, candidate, published>>

BodyName(name) ==
  /\ phase = "body"
  /\ Len(body) < Capacity
  /\ name \notin AsSet(body)
  /\ body' = Append(body, name)
  /\ active' = active \cup {name}
  /\ UNCHANGED <<phase, header, candidate, published>>

ReadCandidate ==
  /\ phase \in {"header", "body"}
  /\ ~candidate
  /\ candidate' = TRUE
  /\ UNCHANGED <<phase, header, body, active, published>>

Finish ==
  /\ phase = "body"
  /\ phase' = "complete"
  /\ active' = Outer
  /\ published' = candidate
  /\ UNCHANGED <<header, body, candidate>>

Next == BeginBody \/ Finish \/ ReadCandidate
        \/ (\E name \in Names : HeaderName(name) \/ BodyName(name))

Spec == Init /\ [][Next]_vars
Scope ==
  /\ IF phase \in {"failed", "complete"} THEN active = Outer
     ELSE active = Outer \cup AsSet(header) \cup AsSet(body)
  /\ (phase = "failed") = ~Unique(header)
Publication == published => phase = "complete" /\ candidate /\ Unique(header)
=============================================================================
