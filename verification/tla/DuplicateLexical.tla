------------------------- MODULE DuplicateLexical -------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Names, MaxLength
VARIABLES source, cursor, first, repeated, phase
vars == <<source, cursor, first, repeated, phase>>

Missing == [name |-> "", original |-> 0, duplicate |-> 0]
Positions == 1..cursor
Earlier(name) == {i \in Positions : source[i] = name}
FirstPosition(set) == CHOOSE i \in set : \A j \in set : i <= j
RepeatedPositions == {i \in Positions : \E j \in 1..(i - 1) : source[j] = source[i]}

Init ==
  /\ source \in UNION {[1..n -> Names \cup {"?"}] : n \in 0..MaxLength}
  /\ cursor = 0
  /\ first = [n \in Names |-> 0]
  /\ repeated = Missing
  /\ phase = "reading"

Read ==
  /\ phase = "reading"
  /\ cursor < Len(source)
  /\ LET n == source[cursor + 1]
     IN IF n = "?" THEN
          /\ phase' = "declined"
          /\ UNCHANGED <<cursor, first, repeated>>
        ELSE IF first[n] = 0 THEN
          /\ UNCHANGED <<phase, repeated>>
          /\ cursor' = cursor + 1
          /\ first' = [first EXCEPT ![n] = cursor']
        ELSE IF repeated = Missing THEN
          /\ UNCHANGED <<phase, first>>
          /\ cursor' = cursor + 1
          /\ repeated' = [name |-> n, original |-> first[n], duplicate |-> cursor']
        ELSE
          /\ phase' = "declined"
          /\ UNCHANGED <<cursor, first, repeated>>
  /\ UNCHANGED source

Finish ==
  /\ phase = "reading"
  /\ cursor = Len(source)
  /\ phase' = IF repeated = Missing THEN "declined" ELSE "reported"
  /\ UNCHANGED <<source, cursor, first, repeated>>

Spec == Init /\ [][Read \/ Finish]_vars

Registration ==
  \A n \in Names :
    IF Earlier(n) = {} THEN first[n] = 0 ELSE first[n] = FirstPosition(Earlier(n))

WholeFileDiagnostic ==
  phase = "reported" =>
    /\ cursor = Len(source)
    /\ \A i \in Positions : source[i] \in Names
    /\ RepeatedPositions = {repeated.duplicate}
    /\ repeated.original < repeated.duplicate
    /\ repeated.name = source[repeated.original]
    /\ repeated.name = source[repeated.duplicate]
    /\ repeated.original = first[repeated.name]
=============================================================================
