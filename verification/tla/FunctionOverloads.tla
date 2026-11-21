--------------------------- MODULE FunctionOverloads --------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES forms, functions, body, value, exported, invalid
vars == <<forms, functions, body, value, exported, invalid>>

Kinds == {"signature", "body", "value", "type", "reexport"}
Function(kind) == kind \in {"signature", "body"}
Export(kind) == kind \in {"body", "reexport"}
Seen(class) == \E i \in DOMAIN forms : forms[i] \in class
Conflicting ==
  \E i,j \in DOMAIN forms :
    i < j /\
    ((Export(forms[i]) /\ Export(forms[j])) \/
     (forms[i] = "value" /\ (Function(forms[j]) \/ forms[j] = "value")) \/
     (Function(forms[i]) /\ forms[j] = "value"))

Init == /\ forms = <<>>
        /\ functions = FALSE
        /\ body = FALSE
        /\ value = FALSE
        /\ exported = FALSE
        /\ invalid = FALSE

Read(kind) ==
  /\ ~invalid
  /\ Len(forms) < Capacity
  /\ forms' = Append(forms, kind)
  /\ invalid' = ((Function(kind) /\ value) \/
                  (kind = "value" /\ (functions \/ value)) \/
                  (kind = "body" /\ body) \/
                  (Export(kind) /\ exported))
  /\ functions' = (functions \/ Function(kind))
  /\ body' = (body \/ kind = "body")
  /\ value' = (value \/ kind = "value")
  /\ exported' = (exported \/ Export(kind))

Next == \E kind \in Kinds : Read(kind)
Spec == Init /\ [][Next]_vars
Group ==
  /\ functions = Seen({"signature", "body"})
  /\ body = Seen({"body"})
  /\ value = Seen({"value"})
  /\ exported = Seen({"body", "reexport"})
  /\ invalid = Conflicting
=============================================================================
