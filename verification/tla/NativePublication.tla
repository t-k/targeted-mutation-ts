------------------------- MODULE NativePublication -------------------------
EXTENDS Naturals, TLC

CONSTANTS Initial, Limit
VARIABLES phase, need, suffixValid, exported
vars == <<phase, need, suffixValid, exported>>

Init ==
  /\ phase = "stack"
  /\ need \in 0..(Limit + 1)
  /\ suffixValid \in BOOLEAN
  /\ exported = 0

Complete(capacity) ==
  /\ need <= capacity
  /\ suffixValid
  /\ phase' = "done"
  /\ exported' = need
  /\ UNCHANGED <<need, suffixValid>>

Fallback ==
  /\ phase' = "fallback"
  /\ exported' = 0
  /\ UNCHANGED <<need, suffixValid>>

Next ==
  \/ /\ phase = "stack"
     /\ \/ /\ need > Initial
           /\ phase' = "heap"
           /\ UNCHANGED <<need, suffixValid, exported>>
        \/ /\ need <= Initial
           /\ IF suffixValid THEN Complete(Initial) ELSE Fallback
  \/ /\ phase = "heap"
     /\ IF suffixValid /\ need <= Limit THEN Complete(Limit) ELSE Fallback

Spec == Init /\ [][Next]_vars

NoPartial ==
  /\ phase = "done" => suffixValid /\ exported = need /\ exported <= Limit
  /\ phase # "done" => exported = 0
=============================================================================
