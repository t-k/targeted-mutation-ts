---------------------------- MODULE SuperContexts -----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES frames, propertyAccess, constructorCall, argumentsAccess
vars == <<frames, propertyAccess, constructorCall, argumentsAccess>>

Kinds == {"ordinary", "arrow", "method", "base", "derived", "block", "field"}
Inherited == {"arrow", "block"}

RECURSIVE Property(_), Call(_), Arguments(_)
Property(stack) ==
  IF Len(stack) = 0 THEN FALSE
  ELSE IF Head(stack) \in Inherited THEN Property(Tail(stack))
  ELSE Head(stack) \in {"method", "base", "derived", "field"}
Call(stack) ==
  IF Len(stack) = 0 THEN FALSE
  ELSE IF Head(stack) \in Inherited THEN Call(Tail(stack))
  ELSE Head(stack) = "derived"

Arguments(stack) ==
  IF Len(stack) = 0 THEN TRUE
  ELSE IF Head(stack) \in Inherited THEN Arguments(Tail(stack))
  ELSE Head(stack) # "field"

Init == /\ frames = <<>>
        /\ propertyAccess = <<FALSE>>
        /\ constructorCall = <<FALSE>>
        /\ argumentsAccess = <<TRUE>>

Enter(kind) ==
  /\ Len(frames) < Capacity
  /\ frames' = <<kind>> \o frames
  /\ propertyAccess' = <<IF kind \in Inherited THEN Head(propertyAccess)
                        ELSE kind \in {"method", "base", "derived", "field"}>> \o propertyAccess
  /\ constructorCall' = <<IF kind \in Inherited THEN Head(constructorCall)
                          ELSE kind = "derived">> \o constructorCall
  /\ argumentsAccess' = <<IF kind \in Inherited THEN Head(argumentsAccess)
                          ELSE kind # "field">> \o argumentsAccess
Leave ==
  /\ Len(frames) > 0
  /\ frames' = Tail(frames)
  /\ propertyAccess' = Tail(propertyAccess)
  /\ constructorCall' = Tail(constructorCall)
  /\ argumentsAccess' = Tail(argumentsAccess)

Next == (\E kind \in Kinds: Enter(kind)) \/ Leave
Spec == Init /\ [][Next]_vars

SuperScopes ==
  /\ Len(propertyAccess) = Len(frames) + 1
  /\ Len(constructorCall) = Len(frames) + 1
  /\ Len(argumentsAccess) = Len(frames) + 1
  /\ Head(propertyAccess) = Property(frames)
  /\ Head(constructorCall) = Call(frames)
  /\ Head(argumentsAccess) = Arguments(frames)
=============================================================================
