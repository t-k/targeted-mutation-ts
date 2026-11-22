---- MODULE PrivateNameLog ----
EXTENDS Naturals, Sequences

CONSTANT Capacity
VARIABLES events, current, checkpoint, published
vars == <<events, current, checkpoint, published>>

Names == {"x", "y"}
ScopeAt(items, index) ==
  IF index = 0 \/ index > Len(items) THEN FALSE ELSE items[index].kind = "scope"

RECURSIVE Visible(_, _, _)
Visible(items, owner, name) ==
  IF ~ScopeAt(items, owner) THEN FALSE ELSE
    (\E i \in (owner + 1)..Len(items):
      items[i].kind = "decl" /\ items[i].owner = owner /\ items[i].name = name)
    \/ Visible(items, items[owner].owner, name)

OwnerGraph(items) ==
  \A i \in 1..Len(items):
    LET entry == items[i] IN
    IF entry.owner = 0 THEN entry.kind = "scope"
    ELSE entry.owner < i /\ ScopeAt(items, entry.owner)

Valid(items) ==
  /\ OwnerGraph(items)
  /\ \A i \in 1..Len(items):
       LET entry == items[i] IN
       IF entry.kind = "ref" THEN Visible(items, entry.owner, entry.name)
       ELSE IF entry.kind = "decl" THEN
         ~\E j \in 1..(i - 1): items[j] = entry
       ELSE TRUE

Init ==
  /\ events = <<>>
  /\ current = 0
  /\ checkpoint = [count |-> 0, owner |-> 0]
  /\ published = "pending"

Enter ==
  /\ Len(events) < Capacity
  /\ events' = Append(events, [kind |-> "scope", owner |-> current, name |-> ""])
  /\ current' = Len(events')
  /\ UNCHANGED <<checkpoint, published>>

AppendName ==
  /\ current > 0
  /\ Len(events) < Capacity
  /\ \E kind \in {"decl", "ref"}, name \in Names:
       events' = Append(events, [kind |-> kind, owner |-> current, name |-> name])
  /\ UNCHANGED <<current, checkpoint, published>>

Leave ==
  /\ current > 0
  /\ current' = events[current].owner
  /\ UNCHANGED <<events, checkpoint, published>>

Save ==
  /\ checkpoint' = [count |-> Len(events), owner |-> current]
  /\ UNCHANGED <<events, current, published>>

Rollback ==
  /\ events' = SubSeq(events, 1, checkpoint.count)
  /\ current' = checkpoint.owner
  /\ UNCHANGED <<checkpoint, published>>

Retry ==
  /\ events' = <<>>
  /\ current' = 0
  /\ checkpoint' = [count |-> 0, owner |-> 0]
  /\ UNCHANGED published

Publish ==
  /\ current = 0
  /\ Valid(events)
  /\ published' = events
  /\ UNCHANGED <<events, current, checkpoint>>

Next ==
  /\ published = "pending"
  /\ Enter \/ AppendName \/ Leave \/ Save \/ Rollback \/ Retry \/ Publish

Spec == Init /\ [][Next]_vars

Safe ==
  /\ OwnerGraph(events)
  /\ current = 0 \/ ScopeAt(events, current)
  /\ checkpoint.count <= Len(events)
  /\ checkpoint.owner = 0 \/ (checkpoint.owner <= checkpoint.count /\ ScopeAt(events, checkpoint.owner))
  /\ published = "pending" \/ (published = events /\ Valid(published))
====
