---------------------- MODULE TypeDeclarationNamespaces ----------------------
EXTENDS FiniteSets

Kinds == {"Interface", "Alias", "Namespace", "Value"}
Families == {"Var", "Function"}
Entries == [name: {"a", "b"}, kind: Kinds]
VARIABLES entries, family, phase
vars == <<entries, family, phase>>

Overlap(a, b) ==
  CASE {a, b} = {"Interface", "Namespace"} -> FALSE
    [] "Namespace" \in {a, b} -> TRUE
    [] a \in {"Interface", "Alias"} /\ b \in {"Interface", "Alias"} -> TRUE
    [] OTHER -> a = b

Init == /\ entries = {} /\ family = "Empty" /\ phase = "open"

Bind ==
  \E incoming \in Entries:
    IF \E previous \in entries: incoming.name = previous.name /\ Overlap(incoming.kind, previous.kind)
    THEN /\ phase' = "declined" /\ UNCHANGED <<entries, family>>
    ELSE /\ entries' = entries \cup {incoming} /\ UNCHANGED <<phase, family>>

Ambient ==
  \E nextFamily \in Families:
    IF family \in {"Empty", nextFamily}
    THEN /\ family' = nextFamily /\ UNCHANGED <<phase, entries>>
    ELSE /\ phase' = "declined" /\ UNCHANGED <<entries, family>>

Finish == /\ phase' = "success" /\ UNCHANGED <<entries, family>>
Next == phase = "open" /\ (Bind \/ Ambient \/ Finish)
Spec == Init /\ [][Next]_vars

NoCollidingNames ==
  \A a, b \in entries: (a # b /\ a.name = b.name) => ~Overlap(a.kind, b.kind)

ReservedExports == {e.name : e \in {x \in entries: x.kind \in {"Namespace", "Value"}}}
TypeOnlyNames ==
  \A e \in entries: (e.kind \in {"Alias", "Interface"} /\ e.name \in ReservedExports) =>
    \E value \in entries: value.name = e.name /\ value.kind \in {"Namespace", "Value"}

AmbientFamilyStable == family \in Families \cup {"Empty"}
=============================================================================
