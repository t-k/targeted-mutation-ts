---------------------------- MODULE ModuleExports ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Capacity
VARIABLES statements, visible, invalid, prefix, published, finished
vars == <<statements, visible, invalid, prefix, published, finished>>

Names == {"a", "b", "default"}
Kinds == {"declared", "reexported", "type"}
CountsAsExport(kind) == kind # "type"
ExportedNames == {statements[i].name :
  i \in {j \in DOMAIN statements : CountsAsExport(statements[j].kind)}}
Duplicate == \E i,j \in DOMAIN statements :
  i < j /\ statements[i].name = statements[j].name
  /\ CountsAsExport(statements[i].kind) /\ CountsAsExport(statements[j].kind)

Init == /\ statements = <<>>
        /\ visible = {}
        /\ invalid = FALSE
        /\ prefix = FALSE
        /\ published = FALSE
        /\ finished = FALSE

Register(kind, name) ==
  /\ Len(statements) < Capacity
  /\ statements' = Append(statements, [kind |-> kind, name |-> name])
  /\ invalid' = (CountsAsExport(kind) /\ name \in visible)
  /\ visible' = IF CountsAsExport(kind) THEN visible \cup {name} ELSE visible
  /\ UNCHANGED <<prefix, published, finished>>

Candidate ==
  /\ ~prefix
  /\ prefix' = TRUE
  /\ UNCHANGED <<statements, visible, invalid, published, finished>>

Finish ==
  /\ finished' = TRUE
  /\ published' = (prefix /\ ~invalid)
  /\ UNCHANGED <<statements, visible, invalid, prefix>>

Next == /\ ~finished
        /\ Finish \/ (~invalid /\ (Candidate \/ (\E kind \in Kinds, name \in Names : Register(kind, name))))

Spec == Init /\ [][Next]_vars
ExportIdentity == /\ visible = ExportedNames
                  /\ invalid = Duplicate
Publication == (published => finished /\ prefix /\ ~Duplicate)
=============================================================================
