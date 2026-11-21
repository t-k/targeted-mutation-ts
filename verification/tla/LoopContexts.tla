----------------------------- MODULE LoopContexts -----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES frames, permission
vars == <<frames, permission>>

Kinds == {"block", "loop", "function"}

RECURSIVE Allows(_)
Allows(stack) ==
  IF Len(stack) = 0 THEN FALSE
  ELSE CASE Head(stack) = "loop" -> TRUE
         [] Head(stack) = "function" -> FALSE
         [] OTHER -> Allows(Tail(stack))

Init == /\ frames = <<>>
        /\ permission = <<FALSE>>

Enter(kind) ==
  /\ Len(frames) < Capacity
  /\ frames' = <<kind>> \o frames
  /\ permission' = <<CASE kind = "loop" -> TRUE
                       [] kind = "function" -> FALSE
                       [] OTHER -> Head(permission)>> \o permission

Leave ==
  /\ Len(frames) > 0
  /\ frames' = Tail(frames)
  /\ permission' = Tail(permission)

Next == (\E kind \in Kinds : Enter(kind)) \/ Leave
Spec == Init /\ [][Next]_vars
ScopedJumps == Len(permission) = Len(frames) + 1 /\ Head(permission) = Allows(frames)
=============================================================================
