import Std.Tactic.BVDecide

namespace CompilerRuns

def quotePlain (decode : Bool) (byte : UInt8) : Bool :=
  byte >= 32 && byte != 34 && byte != 92 && (!decode || (byte != 38 && byte != 226))

def textPlain (byte : UInt8) : Bool :=
  byte > 32 && byte < 128 && byte != 60 && byte != 62 && byte != 123 && byte != 125

structure Cursor where
  position : Nat
  visible : Bool
  multiline : Bool

-- A blocked byte leaves the run cursor unchanged so the scalar scanner can process it.
def step (plain : UInt8 → Bool) (showsText : Bool) (cursor : Cursor) (byte : UInt8) : Cursor :=
  if plain byte then { cursor with position := cursor.position + 1, visible := cursor.visible || showsText } else cursor

theorem advancePlain (plain : UInt8 → Bool) (showsText : Bool) (bytes : List UInt8) (cursor : Cursor)
    (safe : bytes.all plain = true) :
    bytes.foldl (step plain showsText) cursor =
      { cursor with position := cursor.position + bytes.length, visible := cursor.visible || (showsText && !bytes.isEmpty) } := by
  induction bytes generalizing cursor with
  | nil =>
    cases cursor with
    | mk position visible multiline => cases visible <;> simp
  | cons byte rest inductionHypothesis =>
    simp only [List.all_cons, Bool.and_eq_true] at safe
    rw [List.foldl_cons, inductionHypothesis _ safe.2]
    cases cursor with
    | mk position visible multiline =>
      cases visible <;> cases showsText <;> simp [step, safe.1, Nat.add_comm, Nat.add_left_comm]

theorem skipQuoteBlock (decode : Bool) (bytes : List UInt8) (cursor : Cursor)
    (width : bytes.length = 16) (safe : bytes.all (quotePlain decode) = true) :
    bytes.foldl (step (quotePlain decode) false) cursor = { cursor with position := cursor.position + 16 } := by
  rw [advancePlain _ _ _ _ safe, width]
  simp

theorem skipTextBlock (bytes : List UInt8) (cursor : Cursor)
    (width : bytes.length = 16) (safe : bytes.all textPlain = true) :
    bytes.foldl (step textPlain true) cursor = { cursor with position := cursor.position + 16, visible := true } := by
  have nonempty : bytes.isEmpty = false := by
    cases bytes with
    | nil => simp at width
    | cons _ _ => rfl
  rw [advancePlain _ _ _ _ safe, width, nonempty]
  simp

def eraseTypeByte (byte : UInt8) : UInt8 :=
  if byte == 10 || byte == 13 then byte else 32

def eraseRange (bytes : List UInt8) (first last : Nat) : List UInt8 :=
  bytes.zipIdx.map fun (byte, offset) =>
    if first ≤ offset ∧ offset < last then eraseTypeByte byte else byte

@[simp] theorem eraseRange_length (bytes : List UInt8) (first last : Nat) :
    (eraseRange bytes first last).length = bytes.length := by
  simp [eraseRange]

theorem eraseRange_preserves_byte (bytes : List UInt8) (first last offset : Nat)
    (bound : offset < bytes.length) (outside : ¬(first ≤ offset ∧ offset < last)) :
    (eraseRange bytes first last)[offset]'(by simpa using bound) = bytes[offset] := by
  simp [eraseRange, List.getElem_zipIdx, outside]

theorem eraseRange_preserves_line_end (bytes : List UInt8) (first last offset : Nat)
    (bound : offset < bytes.length) (newline : bytes[offset] = 10 ∨ bytes[offset] = 13) :
    (eraseRange bytes first last)[offset]'(by simpa using bound) = bytes[offset] := by
  rcases newline with lf | cr
  · simp [eraseRange, List.getElem_zipIdx, eraseTypeByte, lf]
  · simp [eraseRange, List.getElem_zipIdx, eraseTypeByte, cr]

def eraseBlock (bytes : List UInt8) : Bool × List UInt8 :=
  (bytes.all (fun byte => byte < 128), bytes.map eraseTypeByte)

theorem eraseBlock_append (left right : List UInt8) :
    eraseBlock (left ++ right) =
      ((eraseBlock left).1 && (eraseBlock right).1, (eraseBlock left).2 ++ (eraseBlock right).2) := by
  simp [eraseBlock, List.all_append, List.map_append]

-- The enum writer uses unsigned C shifts and reconstructs signed right shift.
theorem enumSignedRight (word distance : BitVec 32) :
    let count := distance &&& 31
    (word >>> count) ||| (if word.msb then ~~~((0xffffffff : BitVec 32) >>> count) else 0) =
      BitVec.sshiftRight' word count := by
  dsimp
  bv_decide

theorem enumSignedValue (word : BitVec 32) :
    (if word.msb then (word.toNat : Int) - 4294967296 else (word.toNat : Int)) = word.toInt := by
  rw [BitVec.toInt_eq_msb_cond]
  rfl

end CompilerRuns
