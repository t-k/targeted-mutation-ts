---- MODULE FocusedTraceOrdering ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Producers, MaxWrites
VARIABLES observed, written, queues, overlap, synchronous, result
vars == <<observed, written, queues, overlap, synchronous, result>>

Empty == [p \in Producers |-> <<>>]
Init ==
  /\ observed = <<>> /\ written = <<>> /\ queues = Empty
  /\ overlap = FALSE /\ synchronous = FALSE /\ result = "Running"

ForeignChunk(p) == \E other \in Producers \ {p} : Len(queues[other]) > 0

Emit(p, defer) ==
  LET row == Len(observed) + 1
      buffered == defer /\ ~synchronous
  IN /\ result = "Running" /\ Len(observed) < MaxWrites
     /\ observed' = Append(observed, row)
     /\ IF buffered
          THEN /\ queues' = [queues EXCEPT ![p] = Append(@, row)]
               /\ UNCHANGED written
               /\ overlap' = (overlap \/ (Len(queues[p]) = 0 /\ ForeignChunk(p)))
          ELSE /\ written' = Append(written \o queues[p], row)
               /\ queues' = [queues EXCEPT ![p] = <<>>]
               /\ overlap' = (overlap \/ ForeignChunk(p))
     /\ UNCHANGED <<result, synchronous>>

Flush(p) ==
  /\ result = "Running" /\ Len(queues[p]) > 0
  /\ written' = written \o queues[p]
  /\ queues' = [queues EXCEPT ![p] = <<>>]
  /\ overlap' = (overlap \/ ForeignChunk(p))
  /\ UNCHANGED <<observed, result, synchronous>>

Finish ==
  /\ result = "Running"
  /\ result' = IF queues # Empty THEN "Unavailable"
                ELSE IF overlap THEN "Retry" ELSE "Complete"
  /\ UNCHANGED <<observed, written, queues, overlap, synchronous>>

Retry ==
  /\ result = "Retry" /\ ~synchronous
  /\ observed' = <<>> /\ written' = <<>> /\ queues' = Empty
  /\ overlap' = FALSE /\ synchronous' = TRUE /\ result' = "Running"

Next == (\E p \in Producers, defer \in BOOLEAN : Emit(p, defer))
        \/ (\E p \in Producers : Flush(p)) \/ Finish \/ Retry
Spec == Init /\ [][Next]_vars

ExactAcceptedOrder == result = "Complete" => written = observed
NoOverlapOnRetry == synchronous => ~overlap /\ queues = Empty
====
