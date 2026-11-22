/-
A small JSON reader and writer for the request protocol. It replaces `Lean.Data.Json`, whose import links
the whole Lean library into the executable. Numbers with a fraction or an exponent are kept apart from
integers: every integer the protocol accepts is written by JavaScript as plain decimal digits.
-/
namespace Wire

inductive Value where
  | null
  | bool (value : Bool)
  | int (value : Int)
  | fraction
  | str (value : String)
  | arr (items : Array Value)
  | obj (fields : Array (String × Value))

@[inline] def at? (bytes : ByteArray) (i : Nat) : Option UInt8 :=
  if i < bytes.size then some bytes[i]! else none

@[inline] def is (bytes : ByteArray) (i : Nat) (expected : UInt8) : Bool :=
  i < bytes.size && bytes[i]! == expected

partial def skipSpace (bytes : ByteArray) (i : Nat) : Nat :=
  match at? bytes i with
  | some 0x20 | some 0x09 | some 0x0A | some 0x0D => skipSpace bytes (i + 1)
  | _ => i

partial def digits (bytes : ByteArray) (i : Nat) (value : Nat) : Nat × Nat :=
  match at? bytes i with
  | some b => if 0x30 ≤ b && b ≤ 0x39 then digits bytes (i + 1) (value * 10 + (b.toNat - 0x30)) else (value, i)
  | none => (value, i)

def word (bytes : ByteArray) (i : Nat) (text : String) (value : Value) : Except String (Value × Nat) :=
  let expected := text.toUTF8
  if i + expected.size ≤ bytes.size && (List.range expected.size).all (fun k => bytes[i + k]! == expected[k]!) then
    .ok (value, i + expected.size)
  else .error "invalid literal"

def number (bytes : ByteArray) (start : Nat) : Except String (Value × Nat) := do
  let negative := is bytes start 0x2D
  let first := if negative then start + 1 else start
  let (magnitude, afterInt) := digits bytes first 0
  if afterInt == first then throw "invalid number"
  if is bytes first 0x30 && afterInt != first + 1 then throw "invalid number"
  let mut i := afterInt
  let mut integral := true
  if is bytes i 0x2E then
    let (_, afterFraction) := digits bytes (i + 1) 0
    if afterFraction == i + 1 then throw "invalid number"
    i := afterFraction
    integral := false
  if is bytes i 0x65 || is bytes i 0x45 then
    let signed := is bytes ((i + 1)) 0x2B || is bytes ((i + 1)) 0x2D
    let exponent := if signed then i + 2 else i + 1
    let (_, afterExponent) := digits bytes exponent 0
    if afterExponent == exponent then throw "invalid number"
    i := afterExponent
    integral := false
  let whole : Int := if negative then -(magnitude : Int) else magnitude
  if integral then pure (Value.int whole, i) else pure (Value.fraction, i)

def hex (b : UInt8) : Option Nat :=
  if 0x30 ≤ b && b ≤ 0x39 then some (b.toNat - 0x30)
  else if 0x61 ≤ b && b ≤ 0x66 then some (b.toNat - 0x61 + 10)
  else if 0x41 ≤ b && b ≤ 0x46 then some (b.toNat - 0x41 + 10)
  else none

def unit (bytes : ByteArray) (i : Nat) : Except String Nat := do
  let mut value := 0
  for k in [0:4] do
    match (at? bytes (i + k)).bind hex with
    | some digit => value := value * 16 + digit
    | none => throw "invalid escape"
  pure value

partial def text (bytes : ByteArray) (i : Nat) (out : ByteArray) : Except String (String × Nat) :=
  match at? bytes i with
  | none => .error "unterminated string"
  | some 0x22 =>
    match String.fromUTF8? out with
    | some value => .ok (value, i + 1)
    | none => .error "invalid UTF-8"
  | some 0x5C =>
    match at? bytes (i + 1) with
    | some 0x22 => text bytes (i + 2) (out.push 0x22)
    | some 0x5C => text bytes (i + 2) (out.push 0x5C)
    | some 0x2F => text bytes (i + 2) (out.push 0x2F)
    | some 0x62 => text bytes (i + 2) (out.push 0x08)
    | some 0x66 => text bytes (i + 2) (out.push 0x0C)
    | some 0x6E => text bytes (i + 2) (out.push 0x0A)
    | some 0x72 => text bytes (i + 2) (out.push 0x0D)
    | some 0x74 => text bytes (i + 2) (out.push 0x09)
    | some 0x75 =>
      match unit bytes (i + 2) with
      | .error message => .error message
      | .ok high =>
        let paired : Option Nat :=
          if 0xD800 ≤ high && high < 0xDC00 && is bytes ((i + 6)) 0x5C && is bytes ((i + 7)) 0x75 then
            match unit bytes (i + 8) with
            | .ok low => if 0xDC00 ≤ low && low < 0xE000 then some (0x10000 + (high - 0xD800) * 0x400 + (low - 0xDC00)) else none
            | .error _ => none
          else none
        match paired with
        | some code => text bytes (i + 12) (out ++ (String.singleton (Char.ofNat code)).toUTF8)
        | none => text bytes (i + 6) (out ++ (String.singleton (Char.ofNat high)).toUTF8)
    | _ => .error "invalid escape"
  | some b => if b < 0x20 then .error "control character in string" else text bytes (i + 1) (out.push b)

mutual
  partial def value (bytes : ByteArray) (start : Nat) : Except String (Value × Nat) :=
    let i := skipSpace bytes start
    match at? bytes i with
    | some 0x6E => word bytes i "null" .null
    | some 0x74 => word bytes i "true" (.bool true)
    | some 0x66 => word bytes i "false" (.bool false)
    | some 0x22 => (text bytes (i + 1) ByteArray.empty).map fun (s, next) => (.str s, next)
    | some 0x5B =>
      let next := skipSpace bytes (i + 1)
      if is bytes next 0x5D then .ok (.arr #[], next + 1) else items bytes next #[]
    | some 0x7B =>
      let next := skipSpace bytes (i + 1)
      if is bytes next 0x7D then .ok (.obj #[], next + 1) else fields bytes next #[]
    | some _ => number bytes i
    | none => .error "unexpected end of input"

  partial def items (bytes : ByteArray) (i : Nat) (out : Array Value) : Except String (Value × Nat) :=
    match value bytes i with
    | .error message => .error message
    | .ok (item, afterItem) =>
      let next := skipSpace bytes afterItem
      match at? bytes next with
      | some 0x2C => items bytes (next + 1) (out.push item)
      | some 0x5D => .ok (.arr (out.push item), next + 1)
      | _ => .error "expected , or ]"

  partial def fields (bytes : ByteArray) (start : Nat) (out : Array (String × Value)) : Except String (Value × Nat) :=
    let i := skipSpace bytes start
    if !is bytes i 0x22 then .error "expected a member name" else
    match text bytes (i + 1) ByteArray.empty with
    | .error message => .error message
    | .ok (name, afterName) =>
      if out.any (fun entry => entry.1 == name) then .error "duplicate member name" else
      let colon := skipSpace bytes afterName
      if !is bytes colon 0x3A then .error "expected :" else
      match value bytes (colon + 1) with
      | .error message => .error message
      | .ok (member, afterMember) =>
        let next := skipSpace bytes afterMember
        match at? bytes next with
        | some 0x2C => fields bytes (next + 1) (out.push (name, member))
        | some 0x7D => .ok (.obj (out.push (name, member)), next + 1)
        | _ => .error "expected , or }"
end

def parse (input : String) : Except String Value := do
  let bytes := input.toUTF8
  let (parsed, next) ← value bytes 0
  if skipSpace bytes next != bytes.size then throw "unexpected text after the value"
  pure parsed

namespace Value

def items? : Value → Except String (Array Value)
  | .arr items => .ok items
  | _ => .error "array expected"

def field? (input : Value) (name : String) : Except String Value :=
  match input with
  | .obj fields =>
    match fields.find? (fun entry => entry.1 == name) with
    | some entry => .ok entry.2
    | none => .error s!"missing member {name}"
  | _ => .error "object expected"

def string? : Value → Except String String
  | .str value => .ok value
  | _ => .error "string expected"

def bool? : Value → Except String Bool
  | .bool value => .ok value
  | _ => .error "boolean expected"

def int? : Value → Except String Int
  | .int value => .ok value
  | _ => .error "integer expected"

def nat? : Value → Except String Nat
  | .int value => if value < 0 then .error "natural number expected" else .ok value.toNat
  | _ => .error "natural number expected"

def ints? (input : Value) : Except String (List Int) := do
  (← input.items?).toList.mapM int?

def pairs? (input : Value) : Except String (List (Int × Int)) := do
  (← input.items?).toList.mapM fun entry => do
    match (← entry.items?).toList with
    | [lhs, rhs] => pure (← lhs.int?, ← rhs.int?)
    | _ => throw "pair expected"

end Value

def renderBool (value : Bool) : String := if value then "true" else "false"

def renderArray (items : Array String) : String := "[" ++ ",".intercalate items.toList ++ "]"

end Wire

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

def decodeReplayHeader (input : Wire.Value) : Except String ReplayHeader := do
  let candidate ← (← input.field? "candidate").string?
  let traceCandidate ← (← input.field? "traceCandidate").string?
  let complete ← (← input.field? "complete").bool?
  let deterministic ← (← input.field? "deterministic").bool?
  let original ← decodeOp (← (← input.field? "original").string?)
  let encoded ← input.field? "replacement"
  let replacement ← match encoded with
    | .str op => decodeOp op
    | _ => do
      let literal ← (← encoded.field? "geLiteral").int?
      unless original == .ge && safe literal do throw "invalid literal threshold"
      pure (.geLiteral literal)
  pure { candidate, traceCandidate, complete, deterministic, original, replacement }

def decideReplay (input : Wire.Value) : Except String Bool := do
  let header ← decodeReplayHeader input
  match input.field? "boundarySummary" with
  | .ok encoded =>
    if (input.field? "observations").toOption.isSome then throw "ambiguous replay observations"
    let count ← (← encoded.field? "count").nat?
    let safeAndUnequal ← (← encoded.field? "safeAndUnequal").bool?
    pure (maySkipBoundary header { count, safeAndUnequal })
  | .error _ =>
    let observations ← (← input.field? "observations").pairs?
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

theorem feasible_extrema (threshold lo hi candidate : Int) (observations extrema : List Int)
    (subset : ∀ x ∈ extrema, x ∈ observations)
    (covers : ∀ x ∈ observations,
      (x < threshold → ∃ y ∈ extrema, x ≤ y ∧ y < threshold) ∧
      (threshold ≤ x → ∃ y ∈ extrema, threshold ≤ y ∧ y ≤ x)) :
    Feasible threshold lo hi candidate observations ↔ Feasible threshold lo hi candidate extrema := by
  constructor
  · rintro ⟨lower, upper, agrees⟩
    exact ⟨lower, upper, fun x hx => agrees x (subset x hx)⟩
  · rintro ⟨lower, upper, agrees⟩
    refine ⟨lower, upper, ?_⟩
    intro x hx
    by_cases side : x < threshold
    · obtain ⟨y, hy, atLeast, below⟩ := (covers x hx).1 side
      have witness := agrees y hy
      omega
    · obtain ⟨y, hy, above, atMost⟩ := (covers x hx).2 (by omega)
      have witness := agrees y hy
      omega

theorem bounds_extrema (threshold lo hi : Int) (observations extrema : List Int)
    (inside : lo ≤ threshold ∧ threshold ≤ hi)
    (subset : ∀ x ∈ extrema, x ∈ observations)
    (covers : ∀ x ∈ observations,
      (x < threshold → ∃ y ∈ extrema, x ≤ y ∧ y < threshold) ∧
      (threshold ≤ x → ∃ y ∈ extrema, threshold ≤ y ∧ y ≤ x)) :
    bounds threshold lo hi observations = bounds threshold lo hi extrema := by
  let full := bounds threshold lo hi observations
  let reduced := bounds threshold lo hi extrema
  have equal (candidate : Int) :
      (full.1 ≤ candidate ∧ candidate ≤ full.2) ↔
        (reduced.1 ≤ candidate ∧ candidate ≤ reduced.2) :=
    (bounds_exact threshold lo hi candidate observations).trans
      ((feasible_extrema threshold lo hi candidate observations extrema subset covers).trans
        (bounds_exact threshold lo hi candidate extrema).symm)
  have feasible : Feasible threshold lo hi threshold observations := ⟨inside.1, inside.2, by simp⟩
  have fullIn : full.1 ≤ threshold ∧ threshold ≤ full.2 :=
    (bounds_exact threshold lo hi threshold observations).mpr feasible
  have reducedIn := (equal threshold).mp fullIn
  change full = reduced
  apply Prod.ext
  · have forFull := (equal full.1).mp ⟨Int.le_refl _, by omega⟩
    have forReduced := (equal reduced.1).mpr ⟨Int.le_refl _, by omega⟩
    omega
  · have forFull := (equal full.2).mp ⟨by omega, Int.le_refl _⟩
    have forReduced := (equal reduced.2).mpr ⟨by omega, Int.le_refl _⟩
    omega

structure Gap where
  interval : Int × Int
  alternate : Int
  witness : Int
  expected : Bool
  mutant : Bool

def Gap.render (gap : Gap) : String :=
  s!"\{\"interval\":[{gap.interval.1},{gap.interval.2}],\"alternate\":{gap.alternate},\"witness\":{gap.witness}," ++
    s!"\"expected\":{Wire.renderBool gap.expected},\"mutant\":{Wire.renderBool gap.mutant}}"

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

def decodeGap (input : Wire.Value) : Except String (Option Gap) := do
  let threshold ← (← input.field? "threshold").int?
  let lo ← (← input.field? "min").int?
  let hi ← (← input.field? "max").int?
  let xs ← (← input.field? "observations").ints?
  if safe lo && safe hi && lo ≤ threshold && threshold ≤ hi && !xs.isEmpty &&
      xs.all (fun x => lo ≤ x && x ≤ hi) then
    return choose threshold (bounds threshold lo hi xs)
  return none

end Threshold

def main (args : List String) : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match Wire.parse input >>= Wire.Value.items? with
  | .error message =>
    (← IO.getStderr).putStrLn message
    return 1
  | .ok requests =>
    if args == ["thresholds"] then
      let gaps := requests.map fun request => (Threshold.decodeGap request).toOption.join
      (← IO.getStdout).putStrLn (Wire.renderArray (gaps.map fun gap => (gap.map Threshold.Gap.render).getD "null"))
      return 0
    let decisions := requests.map fun request => (decideReplay request).toOption.getD false
    (← IO.getStdout).putStrLn (Wire.renderArray (decisions.map Wire.renderBool))
    return 0

#print axioms maySkip_replays
#print axioms maySkipBoundary_replays

#print axioms Threshold.bounds_exact
#print axioms Threshold.bounds_extrema
#print axioms Threshold.choose_correct

#print axioms Threshold.no_gap_iff_unique
