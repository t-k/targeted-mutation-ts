---------------------------- MODULE SuperContexts -----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES frames, propertyAccess, constructorCall
vars == <<frames, propertyAccess, constructorCall>>

Kinds == {"ordinary", "arrow", "method", "base", "derived", "block"}
Inherited == {"arrow", "block"}

RECURSIVE Property(_), Call(_)
Property(stack) ==
  IF Len(stack) = 0 THEN FALSE
  ELSE IF Head(stack) \in Inherited THEN Property(Tail(stack))
  ELSE Head(stack) \in {"method", "base", "derived"}
Call(stack) ==
  IF Len(stack) = 0 THEN FALSE
  ELSE IF Head(stack) \in Inherited THEN Call(Tail(stack))
  ELSE Head(stack) = "derived"

Init == /\ frames = <<>>
        /\ propertyAccess = <<FALSE>>
        /\ constructorCall = <<FALSE>>

Enter(kind) ==
  /\ Len(frames) < Capacity
  /\ frames' = <<kind>> \o frames
  /\ propertyAccess' = <<IF kind \in Inherited THEN Head(propertyAccess)
                        ELSE kind \in {"method", "base", "derived"}>> \o propertyAccess
  /\ constructorCall' = <<IF kind \in Inherited THEN Head(constructorCall)
                          ELSE kind = "derived">> \o constructorCall
Leave ==
  /\ Len(frames) > 0
  /\ frames' = Tail(frames)
  /\ propertyAccess' = Tail(propertyAccess)
  /\ constructorCall' = Tail(constructorCall)

Next == (\E kind \in Kinds: Enter(kind)) \/ Leave
Spec == Init /\ [][Next]_vars

SuperScopes ==
  /\ Len(propertyAccess) = Len(frames) + 1
  /\ Len(constructorCall) = Len(frames) + 1
  /\ Head(propertyAccess) = Property(frames)
  /\ Head(constructorCall) = Call(frames)
=============================================================================
