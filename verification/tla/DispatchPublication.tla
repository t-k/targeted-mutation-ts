------------------------ MODULE DispatchPublication ------------------------
EXTENDS Naturals, FiniteSets

Readers == {"legacy", "expanded"}
Statuses == {"success", "decline", "limit", "mixed"}
Slots == {1, 2}
NoOwner == [reader |-> "none", pass |-> 0]

VARIABLES phase, first, reader, pass, alternate, marks, owner, published
vars == <<phase, first, reader, pass, alternate, marks, owner, published>>

Init ==
  /\ phase = "read"
  /\ first \in Readers
  /\ reader = first
  /\ pass = 1
  /\ alternate = FALSE
  /\ marks = {}
  /\ owner = NoOwner
  /\ published = {}

Current == [reader |-> reader, pass |-> pass]

Accept ==
  \E written \in SUBSET Slots:
    /\ phase' = "success"
    /\ marks' = { [slot |-> slot, produced |-> Current] : slot \in written }
    /\ owner' = Current
    /\ published' = marks'
    /\ UNCHANGED <<first, reader, pass, alternate>>

RequestExact ==
  /\ pass = 1
  /\ phase' = "read"
  /\ reader' = first
  /\ pass' = 2
  /\ alternate' = FALSE
  /\ marks' = {}
  /\ owner' = NoOwner
  /\ UNCHANGED <<first, published>>

TryAlternate ==
  /\ ~alternate
  /\ phase' = "read"
  /\ reader' \in Readers \ {reader}
  /\ alternate' = TRUE
  /\ marks' = {}
  /\ owner' = NoOwner
  /\ UNCHANGED <<first, pass, published>>

Refuse ==
  \E written \in SUBSET Slots:
    /\ phase' = "failure"
    /\ marks' = { [slot |-> slot, produced |-> Current] : slot \in written }
    /\ owner' = NoOwner
    /\ UNCHANGED <<first, reader, pass, alternate, published>>

Next ==
  /\ phase = "read"
  /\ \E status \in Statuses:
       CASE status = "success" -> Accept
         [] status = "mixed" /\ pass = 1 -> RequestExact
         [] status = "decline" /\ ~alternate -> TryAlternate
         [] status = "limit" /\ reader = "expanded" /\ ~alternate -> TryAlternate
         [] OTHER -> Refuse

Spec == Init /\ [][Next]_vars

Publication ==
  /\ (phase = "success" => owner = Current /\ published = marks /\
        \A item \in published: item.produced = Current)
  /\ (phase # "success" => published = {})
  /\ (phase = "read" => marks = {} /\ owner = NoOwner)
=============================================================================
