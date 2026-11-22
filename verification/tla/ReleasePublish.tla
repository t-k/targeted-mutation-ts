---------------------------- MODULE ReleasePublish ----------------------------
\* A release publishes every platform package before the main package.
\* A run can stop after any step and a later run resumes from the registry state.
EXTENDS FiniteSets

CONSTANTS Platforms, Main

VARIABLES published, running, rejected

Packages == Platforms \cup {Main}

Init == published = {} /\ running = FALSE /\ rejected = FALSE

Start == ~running /\ running' = TRUE /\ UNCHANGED <<published, rejected>>

\* The registry is read before each publish, so a published version is skipped.
Publish(p) ==
  /\ running
  /\ p \notin published
  /\ p = Main => Platforms \subseteq published
  /\ published' = published \cup {p}
  /\ UNCHANGED <<running, rejected>>

\* The registry refuses a platform package: the run stops before the main package.
Reject ==
  /\ running
  /\ \E p \in Platforms : p \notin published
  /\ running' = FALSE
  /\ rejected' = TRUE
  /\ UNCHANGED published

Stop == running /\ running' = FALSE /\ UNCHANGED <<published, rejected>>

Next == Start \/ Reject \/ Stop \/ \E p \in Packages : Publish(p)

Spec == Init /\ [][Next]_<<published, running, rejected>> /\ WF_<<published, running, rejected>>(Next)

\* An installable main package always has every platform package behind it.
MainHasBinaries == Main \in published => Platforms \subseteq published

\* Published versions are immutable: nothing leaves the registry.
Monotonic == [][published \subseteq published']_<<published, running, rejected>>

Complete == published = Packages
===============================================================================
