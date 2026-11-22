-------------------------- MODULE GeneratorContext --------------------------
EXTENDS Naturals, Sequences

CONSTANT Limit
VARIABLES frames, permissions
vars == <<frames, permissions>>

Kinds == {"generator", "ordinary", "parameter", "field", "arrow", "block"}

RECURSIVE Effective(_)
Effective(history) ==
  LET last == history[Len(history)] IN
    IF last = "block" THEN Effective(SubSeq(history, 1, Len(history) - 1))
    ELSE last = "generator"

Init == /\ frames = <<"root">>
        /\ permissions = <<FALSE>>

Push(kind) ==
  /\ Len(frames) < Limit
  /\ frames' = Append(frames, kind)
  /\ permissions' = Append(permissions,
       IF kind = "block" THEN permissions[Len(permissions)] ELSE kind = "generator")

StartBody ==
  /\ frames[Len(frames)] = "parameter"
  /\ frames' = Append(SubSeq(frames, 1, Len(frames) - 1), "generator")
  /\ permissions' = Append(SubSeq(permissions, 1, Len(permissions) - 1), TRUE)

Pop ==
  /\ Len(frames) > 1
  /\ frames' = SubSeq(frames, 1, Len(frames) - 1)
  /\ permissions' = SubSeq(permissions, 1, Len(permissions) - 1)

Next == (\E kind \in Kinds : Push(kind)) \/ StartBody \/ Pop
Spec == Init /\ [][Next]_vars

Scoped ==
  /\ Len(frames) = Len(permissions)
  /\ \A depth \in 1..Len(frames):
       permissions[depth] = Effective(SubSeq(frames, 1, depth))
=============================================================================
