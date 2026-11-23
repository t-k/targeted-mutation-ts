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

def writeWithInsertions : List (List UInt8 × List UInt8) → List UInt8 → List UInt8
  | [], tail => tail
  | (unchanged, inserted) :: rest, tail => unchanged ++ inserted ++ writeWithInsertions rest tail

theorem reserveForInsertions (pieces : List (List UInt8 × List UInt8)) (tail : List UInt8) :
    (writeWithInsertions pieces tail).length =
      (pieces.flatMap Prod.fst ++ tail).length + (pieces.flatMap Prod.snd).length := by
  induction pieces with
  | nil => simp [writeWithInsertions]
  | cons piece rest inductionHypothesis =>
    rcases piece with ⟨unchanged, inserted⟩
    simp [writeWithInsertions, inductionHypothesis]
    omega

def projectionLexicalByte (byte : BitVec 8) : Bool :=
  byte == 34 || byte == 39 || byte == 47 || byte == 60 || byte == 92 || byte == 96

def projectionLexicalFlags (low : BitVec 8) : BitVec 8 :=
  if low == 0 then 64
  else if low == 2 || low == 7 || low == 15 then 4
  else if low == 12 then 40
  else 0

theorem projectionLexicalTable (byte : BitVec 8) :
    ((projectionLexicalFlags (byte &&& 15) &&& ((1 : BitVec 8) <<< (byte >>> 4))) != 0) =
      projectionLexicalByte byte := by
  unfold projectionLexicalFlags projectionLexicalByte
  bv_decide

def projectionHeadFlags (byte : BitVec 8) : BitVec 8 :=
  if byte == 97 then 2
  else if byte == 100 || byte == 114 then 4
  else if byte == 101 then 16
  else if byte == 105 then 48
  else if byte == 110 || byte == 115 then 1
  else if byte == 111 then 128
  else if byte == 112 then 64
  else if byte == 116 then 8
  else 0

def projectionFollowerFlags (byte : BitVec 8) : BitVec 8 :=
  if byte == 97 then 1
  else if byte == 98 || byte == 115 then 2
  else if byte == 101 then 4
  else if byte == 109 then 32
  else if byte == 110 then 16
  else if byte == 114 || byte == 117 then 64
  else if byte == 118 then 128
  else if byte == 121 then 8
  else 0

def projectionKeywordPrefix (head follower : BitVec 8) : Bool :=
  (head == 97 && (follower == 98 || follower == 115)) ||
  ((head == 100 || head == 114) && follower == 101) ||
  (head == 101 && follower == 110) ||
  (head == 105 && (follower == 109 || follower == 110)) ||
  ((head == 110 || head == 115) && follower == 97) ||
  (head == 111 && follower == 118) ||
  (head == 112 && (follower == 114 || follower == 117)) ||
  (head == 116 && follower == 121)

theorem projectionKeywordTables (head follower : BitVec 8) :
    ((projectionHeadFlags head &&& projectionFollowerFlags follower) != 0) =
      projectionKeywordPrefix head follower := by
  unfold projectionHeadFlags projectionFollowerFlags projectionKeywordPrefix
  bv_decide

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
