------------------------------ MODULE TrialAudit ------------------------------
EXTENDS TLC

VARIABLES phase, source, probe, predicted, observed, stable, attempted, active, verdict, audit
vars == <<phase, source, probe, predicted, observed, stable, attempted, active, verdict, audit>>

Conclusive == {"killed", "survived"}
SourceResults == Conclusive \cup {"unevaluated", "timeout"}
ProbeResults == SourceResults \cup {"missing"}
CompatibleProbe == IF ~stable \/ ~attempted THEN "missing"
                   ELSE IF active THEN probe ELSE "unevaluated"

Init ==
  /\ phase = "ready"
  /\ source \in SourceResults
  /\ probe \in ProbeResults
  /\ predicted \in BOOLEAN
  /\ observed \in BOOLEAN
  /\ stable \in BOOLEAN
  /\ attempted \in BOOLEAN
  /\ active \in BOOLEAN
  /\ verdict = "pending"
  /\ audit = "pending"

Finish ==
  /\ phase = "ready"
  /\ phase' = "done"
  /\ LET confirmed == CompatibleProbe
         contradicts == source \in Conclusive
           /\ ((predicted /\ source # "survived") \/ (confirmed \in Conclusive /\ source # confirmed))
         final == IF contradicts THEN "unstable"
                  ELSE IF source = "survived" /\ ~observed THEN "unevaluated"
                  ELSE source
     IN /\ verdict' = final
        /\ audit' = IF contradicts THEN "mismatch"
                   ELSE IF final \in Conclusive
                           /\ IF confirmed = "missing" THEN predicted ELSE confirmed \in Conclusive
                        THEN "agreed"
                        ELSE "inconclusive"
  /\ UNCHANGED <<source, probe, predicted, observed, stable, attempted, active>>

Spec == Init /\ [][Finish]_vars

IndependentAgreement ==
  audit = "agreed" =>
    /\ phase = "done"
    /\ verdict = source
    /\ verdict \in Conclusive
    /\ (predicted /\ source = "survived") \/ (stable /\ attempted /\ active /\ probe = source)

MismatchIsEvidence ==
  audit = "mismatch" =>
    /\ verdict = "unstable"
    /\ source \in Conclusive
    /\ (predicted /\ source = "killed") \/ (stable /\ attempted /\ active /\ probe \in Conclusive /\ probe # source)
=============================================================================
