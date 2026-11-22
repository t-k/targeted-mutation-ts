-------------------------- MODULE NativeProfileBuild --------------------------
EXTENDS TLC

VARIABLES phase, requestProfile, toolReady, trainingOK, profileOK, regularOK, published, defaultVariant
vars == <<phase, requestProfile, toolReady, trainingOK, profileOK, regularOK, published, defaultVariant>>
inputs == <<requestProfile, toolReady, trainingOK, profileOK, regularOK>>

Init ==
  /\ phase = "start"
  /\ requestProfile \in BOOLEAN
  /\ toolReady \in BOOLEAN
  /\ trainingOK \in BOOLEAN
  /\ profileOK \in BOOLEAN
  /\ regularOK \in BOOLEAN
  /\ published = "previous"
  /\ defaultVariant = "standalone"

Choose ==
  /\ phase = "start"
  /\ phase' = IF requestProfile /\ toolReady THEN "training" ELSE "regular"
  /\ UNCHANGED <<inputs, published, defaultVariant>>

Train ==
  /\ phase = "training"
  /\ phase' = IF trainingOK THEN "profile" ELSE "regular"
  /\ UNCHANGED <<inputs, published, defaultVariant>>

Profile ==
  /\ phase = "profile"
  /\ phase' = IF profileOK THEN "done" ELSE "regular"
  /\ published' = IF profileOK THEN "profile" ELSE "previous"
  /\ UNCHANGED <<inputs, defaultVariant>>

Regular ==
  /\ phase = "regular"
  /\ phase' = IF regularOK THEN "done" ELSE "failed"
  /\ published' = IF regularOK THEN "regular" ELSE "previous"
  /\ UNCHANGED <<inputs, defaultVariant>>

ManualBuild(variant) ==
  /\ defaultVariant' = variant
  /\ UNCHANGED <<phase, inputs, published>>

Next == Choose \/ Train \/ Profile \/ Regular \/ (\E variant \in {"standalone", "normal"} : ManualBuild(variant))
Spec == Init /\ [][Next]_vars

Publication ==
  /\ phase = "done" => published # "previous"
  /\ phase # "done" => published = "previous"
  /\ published = "profile" => requestProfile /\ toolReady /\ trainingOK /\ profileOK
  /\ published = "regular" => regularOK
  /\ published \in {"previous", "profile", "regular"}
=============================================================================
