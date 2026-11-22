import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Lean.Data.Json.FromToJson.Basic

open Lean

inductive Op where
  | lt | le | gt | ge | constantTrue | geLiteral (value : Int)
deriving DecidableEq, Repr

def compareBy (op : Op) (lhs rhs : Int) : Bool :=
  match op with
  | .lt => lhs < rhs
  | .le => lhs ≤ rhs
  | .gt => lhs > rhs
  | .ge => lhs ≥ rhs
  | .constantTrue => true
  | .geLiteral value => lhs ≥ value

structure Observation where
  site : Nat
  lhs : Int
  rhs : Int
deriving DecidableEq, Repr

inductive Program where
  | finish (passes : Bool)
  | comparison (inputs : Observation) (yes no : Program)

def step (rules : Nat → Op) (inputs : Observation) : Bool :=
  compareBy (rules inputs.site) inputs.lhs inputs.rhs

def run (rules : Nat → Op) : Program → Bool × List Observation
  | .finish passes => (passes, [])
  | .comparison inputs yes no =>
    let (result, trace) := if step rules inputs then run rules yes else run rules no
    (result, inputs :: trace)

def agrees (rules : Nat → Op) (changed : Nat → Op) (inputs : Observation) : Bool :=
  step rules inputs == step changed inputs

theorem replay_eq (program : Program) (rules changed : Nat → Op)
    (same : ((run rules program).2).all (agrees rules changed) = true) :
    run changed program = run rules program := by
  induction program with
  | finish passes => rfl
  | comparison inputs yes no yes_ih no_ih =>
    cases br : step rules inputs <;>
      simp only [run, br, Bool.false_eq_true, ↓reduceIte, List.all_cons, Bool.and_eq_true] at same
    · have mutant : step changed inputs = false := by simpa [agrees, br] using same.1
      simp only [run, br, mutant, Bool.false_eq_true, ↓reduceIte, no_ih same.2]
    · have mutant : step changed inputs = true := by simpa [agrees, br] using same.1.symm
      simp only [run, br, mutant, ↓reduceIte, yes_ih same.2]

def safe (n : Int) : Bool := -9007199254740991 ≤ n && n ≤ 9007199254740991

structure ReplayHeader where
  candidate : String
  traceCandidate : String
  complete : Bool
  deterministic : Bool
  original : Op
  replacement : Op

structure Request extends ReplayHeader where
  observations : List (Int × Int)

def checkedPair (original replacement : Op) (pair : Int × Int) : Bool :=
  safe pair.1 && safe pair.2 && (compareBy original pair.1 pair.2 == compareBy replacement pair.1 pair.2)

def readyToReplay (request : ReplayHeader) : Bool :=
  request.candidate != "" && request.candidate == request.traceCandidate &&
  request.complete && request.deterministic

def maySkip (request : Request) : Bool :=
  readyToReplay request.toReplayHeader && !request.observations.isEmpty &&
  request.observations.all (checkedPair request.original request.replacement)

def boundaryFlip (original replacement : Op) : Bool :=
  match original, replacement with
  | .lt, .le | .le, .lt | .gt, .ge | .ge, .gt => true
  | _, _ => false

def safeAndUnequal (pair : Int × Int) : Bool :=
  safe pair.1 && safe pair.2 && pair.1 != pair.2

structure BoundarySummary where
  count : Nat
  safeAndUnequal : Bool

def summarizeBoundary (observations : List (Int × Int)) : BoundarySummary :=
  ⟨observations.length, observations.all safeAndUnequal⟩

def maySkipBoundary (request : ReplayHeader) (summary : BoundarySummary) : Bool :=
  readyToReplay request && boundaryFlip request.original request.replacement &&
  summary.count != 0 && summary.safeAndUnequal

private theorem strict_inclusive_agreement (left right : Int) :
    (decide (left < right) == decide (left ≤ right)) = (left != right) := by
  by_cases less : left < right
  · have le : left ≤ right := by omega
    have different : left ≠ right := by omega
    simp [less, le, different]
  · by_cases equal : left = right
    · subst right
      simp
    · have notLe : ¬ left ≤ right := by omega
      simp [less, notLe, equal]

private theorem boundary_pair (original replacement : Op) (pair : Int × Int)
    (flip : boundaryFlip original replacement = true) :
    checkedPair original replacement pair = safeAndUnequal pair := by
  have swapped : (pair.2 != pair.1) = (pair.1 != pair.2) := by
    simp only [bne, Bool.beq_comm]
  cases original <;> cases replacement <;> simp [boundaryFlip] at flip
  all_goals simp only [checkedPair, safeAndUnequal, compareBy]
  · rw [strict_inclusive_agreement]
  · rw [Bool.beq_comm (a := decide (pair.1 ≤ pair.2)), strict_inclusive_agreement]
  · rw [strict_inclusive_agreement, swapped]
  · rw [Bool.beq_comm (a := decide (pair.2 ≤ pair.1)), strict_inclusive_agreement, swapped]

theorem maySkipBoundary_eq (request : Request)
    (flip : boundaryFlip request.original request.replacement = true) :
    maySkipBoundary request.toReplayHeader (summarizeBoundary request.observations) = maySkip request := by
  have pairs : checkedPair request.original request.replacement = safeAndUnequal := by
    funext pair
    exact boundary_pair _ _ pair flip
  have nonempty : (request.observations.length != 0) = !request.observations.isEmpty := by
    cases request.observations <;> simp
  simp only [maySkipBoundary, maySkip, summarizeBoundary, pairs, nonempty]
  simp [flip]

def applyMutation (rules : Nat → Op) (site : Nat) (replacement : Op) : Nat → Op :=
  fun index => if index = site then replacement else rules index

def atSite (site : Nat) (trace : List Observation) : List (Int × Int) :=
  trace.filterMap fun obs => if obs.site = site then some (obs.lhs, obs.rhs) else none

theorem checked_pair_agrees (rules : Nat → Op) (site : Nat) (replacement : Op) (trace : List Observation)
    (pairs : (atSite site trace).all (checkedPair (rules site) replacement) = true) :
    trace.all (agrees rules (applyMutation rules site replacement)) = true := by
  induction trace with
  | nil => rfl
  | cons head tail ih =>
    by_cases atTarget : head.site = site
    · simp only [atSite, List.filterMap_cons, atTarget, ↓reduceIte, List.all_cons, Bool.and_eq_true] at pairs
      have headAgrees := (Bool.and_eq_true_iff.mp pairs.1).2
      simp only [List.all_cons, Bool.and_eq_true]
      refine ⟨?_, ih pairs.2⟩
      simpa only [agrees, step, applyMutation, atTarget, ↓reduceIte] using headAgrees
    · simp only [atSite, List.filterMap_cons, atTarget, ↓reduceIte] at pairs
      simp only [List.all_cons, Bool.and_eq_true]
      refine ⟨?_, ih pairs⟩
      simp [agrees, step, applyMutation, atTarget]

theorem maySkip_replays (program : Program) (rules : Nat → Op) (site : Nat) (request : Request)
    (original : rules site = request.original)
    (complete : request.observations = atSite site (run rules program).2)
    (accepted : maySkip request = true) :
    run (applyMutation rules site request.replacement) program = run rules program := by
  apply replay_eq
  apply checked_pair_agrees
  have observations := (Bool.and_eq_true_iff.mp (show (_ && _) = true from accepted)).2
  simpa only [original, ← complete] using observations

theorem maySkipBoundary_replays (program : Program) (rules : Nat → Op) (site : Nat) (request : Request)
    (original : rules site = request.original)
    (complete : request.observations = atSite site (run rules program).2)
    (flip : boundaryFlip request.original request.replacement = true)
    (accepted : maySkipBoundary request.toReplayHeader (summarizeBoundary request.observations) = true) :
    run (applyMutation rules site request.replacement) program = run rules program := by
  exact maySkip_replays program rules site request original complete ((maySkipBoundary_eq request flip) ▸ accepted)

def decodeOp (op : String) : Except String Op :=
  match op with
  | "<" => .ok .lt
  | "<=" => .ok .le
  | ">" => .ok .gt
  | ">=" => .ok .ge
  | "true" => .ok .constantTrue
  | _ => .error "unknown operator"

def decodeReplayHeader (input : Json) : Except String ReplayHeader := do
  let candidate ← input.getObjValAs? String "candidate"
  let traceCandidate ← input.getObjValAs? String "traceCandidate"
  let complete ← input.getObjValAs? Bool "complete"
  let deterministic ← input.getObjValAs? Bool "deterministic"
  let original ← decodeOp (← input.getObjValAs? String "original")
  let encoded ← input.getObjVal? "replacement"
  let replacement ← match encoded with
    | .str op => decodeOp op
    | _ => do
      let literal ← encoded.getObjValAs? Int "geLiteral"
      unless original == .ge && safe literal do throw "invalid literal threshold"
      pure (.geLiteral literal)
  pure { candidate, traceCandidate, complete, deterministic, original, replacement }

def decideReplay (input : Json) : Except String Bool := do
  let header ← decodeReplayHeader input
  match input.getObjVal? "boundarySummary" with
  | .ok encoded =>
    if (input.getObjVal? "observations").toOption.isSome then throw "ambiguous replay observations"
    let count ← encoded.getObjValAs? Nat "count"
    let safeAndUnequal ← encoded.getObjValAs? Bool "safeAndUnequal"
    pure (maySkipBoundary header { count, safeAndUnequal })
  | .error _ =>
    let observations ← input.getObjValAs? (List (Int × Int)) "observations"
    pure (maySkip { toReplayHeader := header, observations })

namespace Threshold

def bounds (threshold lo hi : Int) : List Int → Int × Int
  | [] => (lo, hi)
  | x :: xs =>
    if x < threshold then bounds threshold (max lo (x + 1)) hi xs
    else bounds threshold lo (min hi x) xs

def Feasible (threshold lo hi candidate : Int) (xs : List Int) : Prop :=
  lo ≤ candidate ∧ candidate ≤ hi ∧ ∀ x ∈ xs, (threshold ≤ x ↔ candidate ≤ x)

theorem bounds_exact (threshold lo hi candidate : Int) (xs : List Int) :
    let b := bounds threshold lo hi xs
    (b.1 ≤ candidate ∧ candidate ≤ b.2) ↔ Feasible threshold lo hi candidate xs := by
  induction xs generalizing lo hi with
  | nil => simp [bounds, Feasible]
  | cons x xs ih =>
    simp only [bounds]
    split <;> rename_i hx <;>
      simp only [ih, Feasible, List.mem_cons, forall_eq_or_imp, Int.max_le, Int.le_min]
    · constructor
      · rintro ⟨⟨lower, next⟩, upper, rest⟩
        exact ⟨lower, upper, by omega, rest⟩
      · rintro ⟨lower, upper, same, rest⟩
        exact ⟨⟨lower, by omega⟩, upper, rest⟩
    · constructor
      · rintro ⟨lower, ⟨upper, previous⟩, rest⟩
        exact ⟨lower, upper, by omega, rest⟩
      · rintro ⟨lower, upper, same, rest⟩
        exact ⟨lower, ⟨upper, by omega⟩, rest⟩

structure Gap where
  interval : Int × Int
  alternate : Int
  witness : Int
  expected : Bool
  mutant : Bool
deriving ToJson

def choose (threshold : Int) (b : Int × Int) : Option Gap :=
  if b.1 < threshold then
    some ⟨b, threshold - 1, threshold - 1, false, true⟩
  else if threshold < b.2 then
    some ⟨b, threshold + 1, threshold, true, false⟩
  else none

theorem choose_correct (threshold lo hi : Int) (xs : List Int) (g : Gap)
    (inside : lo ≤ threshold ∧ threshold ≤ hi)
    (chosen : choose threshold (bounds threshold lo hi xs) = some g) :
    Feasible threshold lo hi g.alternate xs ∧
    g.interval = bounds threshold lo hi xs ∧
    (g.alternate = threshold - 1 ∨ g.alternate = threshold + 1) ∧
    (g.expected = decide (threshold ≤ g.witness)) ∧
    (g.mutant = decide (g.alternate ≤ g.witness)) ∧
    g.expected ≠ g.mutant ∧
    ∀ c, Feasible threshold lo hi c xs →
      ((c < threshold ∧ g.alternate < threshold) ∨ (threshold < c ∧ threshold < g.alternate)) →
      decide (c ≤ g.witness) = g.mutant := by
  have self := (bounds_exact threshold lo hi threshold xs).mpr
    (show Feasible threshold lo hi threshold xs from ⟨inside.1, inside.2, by simp⟩)
  unfold choose at chosen
  split at chosen
  · cases chosen
    refine ⟨(bounds_exact ..).mp (by dsimp; omega), rfl, Or.inl rfl, by simp <;> omega,
      by simp <;> omega, by simp, ?_⟩
    intro c _ side
    simp only at side ⊢
    simp [show c ≤ threshold - 1 by omega]
  · split at chosen
    · cases chosen
      refine ⟨(bounds_exact ..).mp (by dsimp; omega), rfl, Or.inr rfl, by simp,
        by simp <;> omega, by simp, ?_⟩
      intro c _ side
      simp only at side ⊢
      simp [show ¬ c ≤ threshold by omega]
    · contradiction

theorem no_gap_iff_unique (threshold lo hi : Int) (xs : List Int)
    (inside : lo ≤ threshold ∧ threshold ≤ hi) :
    choose threshold (bounds threshold lo hi xs) = none ↔
      ∀ c, Feasible threshold lo hi c xs → c = threshold := by
  have self := (bounds_exact threshold lo hi threshold xs).mpr
    (show Feasible threshold lo hi threshold xs from ⟨inside.1, inside.2, by simp⟩)
  constructor
  · intro noGap c feasible
    have member := (bounds_exact ..).mpr feasible
    unfold choose at noGap
    split at noGap <;> try contradiction
    split at noGap <;> first | contradiction | omega
  · intro unique
    unfold choose
    split <;> rename_i lower
    · have adjacent := unique (threshold - 1) ((bounds_exact ..).mp (by omega))
      omega
    · split <;> rename_i upper
      · have adjacent := unique (threshold + 1) ((bounds_exact ..).mp (by omega))
        omega
      · rfl

def decodeGap (input : Json) : Except String (Option Gap) := do
  let threshold ← input.getObjValAs? Int "threshold"
  let lo ← input.getObjValAs? Int "min"
  let hi ← input.getObjValAs? Int "max"
  let xs ← input.getObjValAs? (List Int) "observations"
  if safe lo && safe hi && lo ≤ threshold && threshold ≤ hi && !xs.isEmpty &&
      xs.all (fun x => lo ≤ x && x ≤ hi) then
    return choose threshold (bounds threshold lo hi xs)
  return none

end Threshold

def main (args : List String) : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match Json.parse input >>= Json.getArr? with
  | .error message =>
    (← IO.getStderr).putStrLn message
    return 1
  | .ok requests =>
    if args == ["thresholds"] then
      let gaps := requests.map fun request => (Threshold.decodeGap request).toOption.join
      (← IO.getStdout).putStrLn (toJson gaps).compress
      return 0
    let decisions := requests.map fun request => (decideReplay request).toOption.getD false
    (← IO.getStdout).putStrLn (toJson decisions).compress
    return 0

#print axioms maySkip_replays
#print axioms maySkipBoundary_replays

#print axioms Threshold.bounds_exact
#print axioms Threshold.choose_correct

#print axioms Threshold.no_gap_iff_unique
