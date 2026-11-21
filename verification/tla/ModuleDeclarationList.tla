----------------------- MODULE ModuleDeclarationList -----------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Names, MaxLength
VARIABLES entries, cursor, incoming, previousExports, listed, exports, direct, phase
vars == <<entries, cursor, incoming, previousExports, listed, exports, direct, phase>>

Init ==
  /\ entries \in UNION {[1..n -> Names \cup {"?"}] : n \in 1..MaxLength}
  /\ cursor = 0
  /\ incoming \in SUBSET Names
  /\ previousExports \in SUBSET Names
  /\ listed = {}
  /\ exports = previousExports
  /\ direct \in BOOLEAN
  /\ phase = "reading"

Read ==
  /\ phase = "reading"
  /\ cursor < Len(entries)
  /\ LET n == entries[cursor + 1]
     IN IF n = "?" \/ n \in incoming \cup listed THEN
          /\ phase' = "failure"
          /\ UNCHANGED <<cursor, listed>>
        ELSE
          /\ cursor' = cursor + 1
          /\ listed' = listed \cup {n}
          /\ UNCHANGED phase
  /\ UNCHANGED <<entries, incoming, previousExports, direct, exports>>

Finish ==
  /\ phase = "reading"
  /\ cursor = Len(entries)
  /\ IF direct /\ previousExports \cap listed # {} THEN
       /\ phase' = "failure"
       /\ UNCHANGED exports
     ELSE
       /\ phase' = "success"
       /\ exports' = IF direct THEN previousExports \cup listed ELSE previousExports
  /\ UNCHANGED <<entries, cursor, incoming, previousExports, listed, direct>>

Spec == Init /\ [][Read \/ Finish]_vars

NamesRead ==
  /\ listed = {entries[i] : i \in 1..cursor}
  /\ listed \cap incoming = {}
  /\ Cardinality(listed) = cursor

Publication ==
  IF phase = "success" THEN
    /\ cursor = Len(entries)
    /\ listed \subseteq Names
    /\ exports = IF direct THEN previousExports \cup listed ELSE previousExports
  ELSE exports = previousExports
=============================================================================
