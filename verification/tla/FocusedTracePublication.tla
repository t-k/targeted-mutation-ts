---- MODULE FocusedTracePublication ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Tasks, MaxWrites
ASSUME 0 \notin Tasks
VARIABLES observed, written, buffered, active, seen, pending, closed, running, result

vars == <<observed, written, buffered, active, seen, pending, closed, running, result>>

Init ==
  /\ observed = <<>>
  /\ written = <<>>
  /\ buffered = <<>>
  /\ active = 0
  /\ seen = {}
  /\ pending = {}
  /\ closed = {}
  /\ running = TRUE
  /\ result = "Unread"

Write(task, hookAvailable) ==
  LET row == Len(observed) + 1
      flush == active # task \/ task = 0
      prefix == IF flush THEN written \o buffered ELSE written
      carry == IF flush THEN <<>> ELSE buffered
      defer == task \in seen \ closed /\ (task \in pending \/ hookAvailable)
  IN /\ running /\ Len(observed) < MaxWrites
     /\ observed' = Append(observed, row)
     /\ active' = task
     /\ seen' = seen \cup ({task} \cap Tasks)
     /\ IF defer
          THEN /\ written' = prefix
               /\ buffered' = Append(carry, row)
               /\ pending' = pending \cup {task}
               /\ UNCHANGED closed
          ELSE /\ written' = Append(prefix, row)
               /\ buffered' = carry
               /\ UNCHANGED pending
               /\ closed' = IF task \in seen THEN closed \cup {task} ELSE closed
     /\ UNCHANGED <<running, result>>

Flush ==
  /\ running /\ Len(buffered) > 0
  /\ written' = written \o buffered
  /\ buffered' = <<>>
  /\ UNCHANGED <<observed, active, seen, pending, closed, running, result>>

Finish(task) ==
  /\ running /\ task \in pending
  /\ written' = written \o buffered
  /\ buffered' = <<>>
  /\ pending' = pending \ {task}
  /\ closed' = closed \cup {task}
  /\ UNCHANGED <<observed, active, seen, running, result>>

Stop ==
  /\ running
  /\ running' = FALSE
  /\ UNCHANGED <<observed, written, buffered, active, seen, pending, closed, result>>

Read ==
  /\ ~running /\ result = "Unread"
  /\ result' = IF pending = {} /\ Len(written) > 0 THEN "Complete" ELSE "Unavailable"
  /\ UNCHANGED <<observed, written, buffered, active, seen, pending, closed, running>>

Next ==
  \/ \E task \in Tasks \cup {0}, hookAvailable \in BOOLEAN : Write(task, hookAvailable)
  \/ Flush
  \/ \E task \in Tasks : Finish(task)
  \/ Stop
  \/ Read

Spec == Init /\ [][Next]_vars

NoReordering == written \o buffered = observed
PendingBeforeBuffering == Len(buffered) > 0 => active \in pending
CompleteTrace == result = "Complete" => written = observed
====
