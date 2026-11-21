------------------------ MODULE ForInitializerContext ------------------------
EXTENDS Naturals, Sequences

CONSTANT Depth
VARIABLES kinds, stack
vars == <<kinds, stack>>

Kinds == {"initializer", "group", "block", "arrow", "consequent"}
Current == stack[Len(stack)]
InsideInitializer == \E i \in DOMAIN kinds : kinds[i] = "initializer"
LastKind == IF Len(kinds) = 0 THEN "root" ELSE kinds[Len(kinds)]

Init == /\ kinds = <<>>
        /\ stack = <<[inside |-> FALSE, allowsIn |-> TRUE]>>

Enter(kind) ==
  /\ Len(kinds) < Depth
  /\ kinds' = Append(kinds, kind)
  /\ LET inside == Current.inside \/ kind = "initializer"
         allowsIn == CASE kind = "initializer" -> FALSE
                       [] kind = "arrow" -> Current.allowsIn /\ ~Current.inside
                       [] OTHER -> TRUE
     IN stack' = Append(stack, [inside |-> inside, allowsIn |-> allowsIn])

Leave ==
  /\ Len(kinds) > 0
  /\ kinds' = SubSeq(kinds, 1, Len(kinds) - 1)
  /\ stack' = SubSeq(stack, 1, Len(stack) - 1)

Next == Leave \/ (\E kind \in Kinds : Enter(kind))
Spec == Init /\ [][Next]_vars

Context ==
  /\ Len(stack) = Len(kinds) + 1
  /\ Current.inside = InsideInitializer
  /\ Current.allowsIn = (LastKind # "initializer" /\ (LastKind # "arrow" \/ ~InsideInitializer))
=============================================================================
