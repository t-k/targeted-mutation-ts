----------------------------- MODULE LoopContexts -----------------------------
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES frames, permission, asyncPermission, moduleMode
vars == <<frames, permission, asyncPermission, moduleMode>>

Kinds == {"block", "loop", "function", "async function"}

RECURSIVE Allows(_)
Allows(stack) ==
  IF Len(stack) = 0 THEN FALSE
  ELSE CASE Head(stack) = "loop" -> TRUE
         [] Head(stack) \in {"function", "async function"} -> FALSE
         [] OTHER -> Allows(Tail(stack))

RECURSIVE AllowsAwait(_, _)
AllowsAwait(stack, root) ==
  IF Len(stack) = 0 THEN root
  ELSE CASE Head(stack) = "function" -> FALSE
         [] Head(stack) = "async function" -> TRUE
         [] OTHER -> AllowsAwait(Tail(stack), root)

Init == /\ frames = <<>>
        /\ permission = <<FALSE>>
        /\ moduleMode \in BOOLEAN
        /\ asyncPermission = <<moduleMode>>

Enter(kind) ==
  /\ Len(frames) < Capacity
  /\ frames' = <<kind>> \o frames
  /\ permission' = <<CASE kind = "loop" -> TRUE
                       [] kind \in {"function", "async function"} -> FALSE
                       [] OTHER -> Head(permission)>> \o permission
  /\ asyncPermission' = <<CASE kind = "function" -> FALSE
                            [] kind = "async function" -> TRUE
                            [] OTHER -> Head(asyncPermission)>> \o asyncPermission
  /\ UNCHANGED moduleMode

Leave ==
  /\ Len(frames) > 0
  /\ frames' = Tail(frames)
  /\ permission' = Tail(permission)
  /\ asyncPermission' = Tail(asyncPermission)
  /\ UNCHANGED moduleMode

Next == (\E kind \in Kinds : Enter(kind)) \/ Leave
Spec == Init /\ [][Next]_vars
ScopedJumps == Len(permission) = Len(frames) + 1 /\ Head(permission) = Allows(frames)
ScopedAwait == Len(asyncPermission) = Len(frames) + 1
               /\ Head(asyncPermission) = AllowsAwait(frames, moduleMode)
=============================================================================
