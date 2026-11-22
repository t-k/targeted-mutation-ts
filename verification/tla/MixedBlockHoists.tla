------------------------------ MODULE MixedBlockHoists ------------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Names, Capacity, Depth
VARIABLES log, marks, scopes, result

vars == <<log, marks, scopes, result>>
EmptyScope(kind) == [kind |-> kind, lexical |-> <<>>, hoisted |-> <<>>]

Init ==
  /\ log = <<>>
  /\ marks = <<0>>
  /\ scopes = <<EmptyScope("function")>>
  /\ result = "open"

Enter ==
  /\ result = "open" /\ Len(scopes) < Depth
  /\ \E kind \in {"block", "function"}:
       scopes' = Append(scopes, EmptyScope(kind))
  /\ marks' = Append(marks, Len(log))
  /\ UNCHANGED <<log, result>>

Declare ==
  /\ result = "open"
  /\ \E name \in Names, role \in {"lexical", "hoisted"}:
       IF Len(log) = Capacity
       THEN /\ result' = "refused"
            /\ UNCHANGED <<log, scopes>>
       ELSE /\ log' = Append(log, [name |-> name, role |-> role])
            /\ scopes' = IF role = "lexical"
                         THEN [scopes EXCEPT ![Len(scopes)].lexical = Append(@, name)]
                         ELSE [scopes EXCEPT ![Len(scopes)].hoisted = Append(@, name)]
            /\ UNCHANGED result
  /\ UNCHANGED marks

Role(entries, role) == SelectSeq(entries, LAMBDA item: item.role = role)
NamesOf(entries) == [i \in 1..Len(entries) |-> entries[i].name]
SetOf(sequence) == {sequence[i] : i \in DOMAIN sequence}

Close ==
  /\ result = "open"
  /\ LET i == Len(scopes)
         mark == marks[i]
         suffix == SubSeq(log, mark + 1, Len(log))
         varsOnly == Role(suffix, "hoisted")
         lexical == Role(suffix, "lexical")
         conflict == SetOf(NamesOf(varsOnly)) \cap SetOf(NamesOf(lexical)) # {}
         keep == scopes[i].kind = "block"
     IN IF conflict
        THEN /\ result' = "refused"
             /\ UNCHANGED <<log, marks, scopes>>
        ELSE /\ log' = SubSeq(log, 1, mark) \o (IF keep THEN varsOnly ELSE <<>>)
             /\ marks' = SubSeq(marks, 1, i - 1)
             /\ scopes' = IF keep
                          THEN [SubSeq(scopes, 1, i - 1) EXCEPT ![i - 1].hoisted = @ \o scopes[i].hoisted]
                          ELSE SubSeq(scopes, 1, i - 1)
             /\ result' = IF i = 1 THEN "published" ELSE "open"

Next == Enter \/ Declare \/ Close
Spec == Init /\ [][Next]_vars

Segments ==
  /\ Len(marks) = Len(scopes)
  /\ \A i \in 1..Len(marks):
       LET last == IF i = Len(marks) THEN Len(log) ELSE marks[i + 1]
           entries == SubSeq(log, marks[i] + 1, last)
       IN /\ marks[i] <= last
          /\ NamesOf(Role(entries, "lexical")) = scopes[i].lexical
          /\ NamesOf(Role(entries, "hoisted")) = scopes[i].hoisted

Bounded == Len(log) <= Capacity
Publication == result = "published" => scopes = <<>> /\ log = <<>>
=====================================================================================
