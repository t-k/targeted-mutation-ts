---- MODULE MixedLocalBindings ----
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES phase, workspace, used, floors, modes, saved, marked, published
vars == <<phase, workspace, used, floors, modes, saved, marked, published>>

Names == {"x", "y"}
Kinds == {"lexical", "var"}
Entry == [name : Names, kind : Kinds]
Empty == [name |-> "", kind |-> ""]
NoCheckpoint == [used |-> 0, depth |-> 0, marked |-> 0, mode |-> {}]
Depth == Len(floors)
Active == phase \in {"primary", "exact"}
EndOf(scope) == IF scope = Depth THEN used ELSE floors[scope + 1]

Init ==
  /\ phase = "primary"
  /\ workspace = [at \in 1..Capacity |-> Empty]
  /\ used = 0
  /\ floors = <<0>>
  /\ modes = <<{}>>
  /\ saved = NoCheckpoint
  /\ marked = 0
  /\ published = 0

Enter ==
  /\ Depth < 2
  /\ floors' = Append(floors, used)
  /\ modes' = Append(modes, {})
  /\ UNCHANGED <<phase, workspace, used, saved, marked, published>>

Leave ==
  /\ Depth > 1
  /\ Depth > saved.depth
  /\ used' = floors[Depth]
  /\ floors' = SubSeq(floors, 1, Depth - 1)
  /\ modes' = SubSeq(modes, 1, Depth - 1)
  /\ UNCHANGED <<phase, workspace, saved, marked, published>>

Declare ==
  \E entry \in Entry:
    LET mode == modes[Depth] \cup {entry.kind}
        clash == \E at \in (floors[Depth] + 1)..used:
          workspace[at].name = entry.name /\ workspace[at].kind # entry.kind
    IN
      /\ IF phase = "primary"
         THEN /\ phase' = IF mode = Kinds THEN "retry" ELSE phase
              /\ modes' = [modes EXCEPT ![Depth] = mode]
              /\ UNCHANGED <<workspace, used>>
         ELSE IF used = Capacity \/ clash
              THEN /\ phase' = "declined"
                   /\ UNCHANGED <<workspace, used, modes>>
              ELSE /\ phase' = phase
                   /\ used' = used + 1
                   /\ workspace' = [workspace EXCEPT ![used'] = entry]
                   /\ modes' = [modes EXCEPT ![Depth] = mode]
      /\ UNCHANGED <<floors, saved, marked, published>>

Checkpoint ==
  /\ saved = NoCheckpoint
  /\ saved' = [used |-> used, depth |-> Depth, marked |-> marked, mode |-> modes[Depth]]
  /\ UNCHANGED <<phase, workspace, used, floors, modes, marked, published>>

Restore ==
  /\ saved.depth = Depth
  /\ used' = saved.used
  /\ marked' = saved.marked
  /\ modes' = [modes EXCEPT ![Depth] = saved.mode]
  /\ saved' = NoCheckpoint
  /\ UNCHANGED <<phase, workspace, floors, published>>

CommitCheckpoint ==
  /\ saved.depth = Depth
  /\ saved' = NoCheckpoint
  /\ UNCHANGED <<phase, workspace, used, floors, modes, marked, published>>

Retry ==
  /\ phase = "retry"
  /\ phase' = "exact"
  /\ used' = 0
  /\ floors' = <<0>>
  /\ modes' = <<{}>>
  /\ saved' = NoCheckpoint
  /\ marked' = 0
  /\ UNCHANGED <<workspace, published>>

Mark ==
  /\ marked < 2
  /\ marked' = marked + 1
  /\ UNCHANGED <<phase, workspace, used, floors, modes, saved, published>>

Decline ==
  /\ phase' = "declined"
  /\ UNCHANGED <<workspace, used, floors, modes, saved, marked, published>>

Publish ==
  /\ Depth = 1
  /\ saved = NoCheckpoint
  /\ phase' = "published"
  /\ published' = marked
  /\ UNCHANGED <<workspace, used, floors, modes, saved, marked>>

Next == Retry \/ (Active /\
  (Enter \/ Leave \/ Declare \/ Checkpoint \/ Restore \/ CommitCheckpoint \/ Mark \/ Decline \/ Publish))

Spec == Init /\ [][Next]_vars

Safe ==
  /\ used <= Capacity
  /\ Depth = Len(modes)
  /\ \A scope \in 1..Depth: floors[scope] <= EndOf(scope)
  /\ \A at \in 1..used: workspace[at] \in Entry
  /\ \A scope \in 1..Depth:
       \A first, second \in (floors[scope] + 1)..EndOf(scope):
         workspace[first].name = workspace[second].name => workspace[first].kind = workspace[second].kind
  /\ saved.depth # 0 => saved.depth <= Depth /\ floors[saved.depth] <= saved.used /\ saved.used <= used
  /\ phase = "published" => published = marked /\ (Kinds \notin {modes[scope] : scope \in 1..Depth} \/ used > 0)
  /\ phase # "published" => published = 0
====
