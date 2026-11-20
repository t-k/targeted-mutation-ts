import Lean.Data.Json.Parser
import Lean.Data.Json.Printer
import Lean.Data.Json.FromToJson.Basic

open Lean

inductive Op where
  | lt | le | gt | ge | constantTrue
deriving DecidableEq, Repr

def compareBy (op : Op) (lhs rhs : Int) : Bool :=
  match op with
  | .lt => lhs < rhs
  | .le => lhs ≤ rhs
  | .gt => lhs > rhs
  | .ge => lhs ≥ rhs
  | .constantTrue => true

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

structure Request where
  candidate : String
  traceCandidate : String
  complete : Bool
  deterministic : Bool
  original : Op
  replacement : Op
  observations : List (Int × Int)

def checkedPair (original replacement : Op) (pair : Int × Int) : Bool :=
  safe pair.1 && safe pair.2 && (compareBy original pair.1 pair.2 == compareBy replacement pair.1 pair.2)

def maySkip (request : Request) : Bool :=
  request.candidate != "" && request.candidate == request.traceCandidate &&
  request.complete && request.deterministic && !request.observations.isEmpty &&
  request.observations.all (checkedPair request.original request.replacement)

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

def decodeOp (op : String) : Except String Op :=
  match op with
  | "<" => .ok .lt
  | "<=" => .ok .le
  | ">" => .ok .gt
  | ">=" => .ok .ge
  | "true" => .ok .constantTrue
  | _ => .error "unknown operator"

def decodeRequest (input : Json) : Except String Request := do
  let candidate ← input.getObjValAs? String "candidate"
  let traceCandidate ← input.getObjValAs? String "traceCandidate"
  let complete ← input.getObjValAs? Bool "complete"
  let deterministic ← input.getObjValAs? Bool "deterministic"
  let original ← decodeOp (← input.getObjValAs? String "original")
  let replacement ← decodeOp (← input.getObjValAs? String "replacement")
  let observations ← input.getObjValAs? (List (Int × Int)) "observations"
  pure { candidate, traceCandidate, complete, deterministic, original, replacement, observations }

def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match Json.parse input >>= Json.getArr? with
  | .error message =>
    (← IO.getStderr).putStrLn message
    return 1
  | .ok requests =>
    let decisions := requests.map fun request =>
      match decodeRequest request with
      | .ok decoded => maySkip decoded
      | .error _ => false
    (← IO.getStdout).putStrLn (toJson decisions).compress
    return 0

#print axioms maySkip_replays
