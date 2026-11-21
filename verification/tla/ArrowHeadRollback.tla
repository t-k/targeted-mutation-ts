------------------------- MODULE ArrowHeadRollback -------------------------
EXTENDS Naturals, Sequences

CONSTANT Slots, Depth
VARIABLES tape, live, stack, phase
vars == <<tape, live, stack, phase>>

Tracks == {"candidate", "binding"}
Values == {"x", "y"}
Written(track) == Len(live[track])
Prefix(whole, count) == SubSeq(whole, 1, count)

Init ==
  /\ tape = [track \in Tracks |-> [i \in 1..Slots |-> ""]]
  /\ live = [track \in Tracks |-> <<>>]
  /\ stack = <<>>
  /\ phase = "parsing"

Begin ==
  /\ phase = "parsing"
  /\ Len(stack) < Depth
  /\ stack' = Append(stack, live)
  /\ UNCHANGED <<tape, live, phase>>

Write(track, value) ==
  /\ phase = "parsing"
  /\ Written(track) < Slots
  /\ tape' = [tape EXCEPT ![track][Written(track) + 1] = value]
  /\ live' = [live EXCEPT ![track] = Append(@, value)]
  /\ UNCHANGED <<stack, phase>>

End(commit) ==
  /\ phase = "parsing"
  /\ Len(stack) > 0
  /\ stack' = Prefix(stack, Len(stack) - 1)
  /\ live' = IF commit THEN live ELSE stack[Len(stack)]
  /\ UNCHANGED <<tape, phase>>

Finish(success) ==
  /\ phase = "parsing"
  /\ Len(stack) = 0
  /\ phase' = IF success THEN "success" ELSE "failure"
  /\ UNCHANGED <<tape, live, stack>>

Next ==
  \/ Begin
  \/ \E track \in Tracks, value \in Values : Write(track, value)
  \/ \E commit \in BOOLEAN : End(commit)
  \/ \E success \in BOOLEAN : Finish(success)

Spec == Init /\ [][Next]_vars

ActivePrefix ==
  \A track \in Tracks :
    /\ Prefix(tape[track], Written(track)) = live[track]
    /\ \A i \in DOMAIN stack :
      /\ Len(stack[i][track]) <= Written(track)
      /\ Prefix(tape[track], Len(stack[i][track])) = stack[i][track]

Published ==
  IF phase = "success" THEN Prefix(tape["candidate"], Written("candidate")) ELSE <<>>

Publication ==
  /\ phase = "success" => Published = live["candidate"] /\ Len(stack) = 0
  /\ phase = "failure" => Published = <<>>
=============================================================================
