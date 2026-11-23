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

end CompilerRuns
