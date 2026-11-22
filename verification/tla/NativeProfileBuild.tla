-------------------------- MODULE NativeProfileBuild --------------------------
EXTENDS TLC

VARIABLES phase, requestProfile, toolReady, trainingOK, profileOK, regularOK, published
vars == <<phase, requestProfile, toolReady, trainingOK, profileOK, regularOK, published>>

Init ==
  /\ phase = "start"
  /\ requestProfile \in BOOLEAN
  /\ toolReady \in BOOLEAN
  /\ trainingOK \in BOOLEAN
  /\ profileOK \in BOOLEAN
  /\ regularOK \in BOOLEAN
  /\ published = "previous"

Choose ==
  /\ phase = "start"
  /\ phase' = IF requestProfile /\ toolReady THEN "training" ELSE "regular"
  /\ UNCHANGED <<requestProfile, toolReady, trainingOK, profileOK, regularOK, published>>

Train ==
  /\ phase = "training"
  /\ phase' = IF trainingOK THEN "profile" ELSE "regular"
  /\ UNCHANGED <<requestProfile, toolReady, trainingOK, profileOK, regularOK, published>>

Profile ==
  /\ phase = "profile"
  /\ phase' = IF profileOK THEN "done" ELSE "regular"
  /\ published' = IF profileOK THEN "profile" ELSE "previous"
  /\ UNCHANGED <<requestProfile, toolReady, trainingOK, profileOK, regularOK>>

Regular ==
  /\ phase = "regular"
  /\ phase' = IF regularOK THEN "done" ELSE "failed"
  /\ published' = IF regularOK THEN "regular" ELSE "previous"
  /\ UNCHANGED <<requestProfile, toolReady, trainingOK, profileOK, regularOK>>

Next == Choose \/ Train \/ Profile \/ Regular
Spec == Init /\ [][Next]_vars

Publication ==
  /\ phase = "done" => published # "previous"
  /\ phase # "done" => published = "previous"
  /\ published = "profile" => requestProfile /\ toolReady /\ trainingOK /\ profileOK
  /\ published = "regular" => regularOK
=============================================================================
