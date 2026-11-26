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

-- A block comment ends at a star followed by a slash. Its scanner records whether it crossed a
-- line break, and every later line break leaves that flag unchanged.
structure CommentCursor where
  position : Nat
  newline : Bool

def lineBreakStart (byte : UInt8) : Bool :=
  byte == 10 || byte == 13 || byte == 226

-- The scalar transition for a byte that is not the star of a terminator.
def commentStep (breaks : UInt8 → Bool) (cursor : CommentCursor) (byte : UInt8) : CommentCursor :=
  { position := cursor.position + 1, newline := cursor.newline || breaks byte }

-- The run skips bytes that cannot start a line break, or any bytes once a line break was seen.
theorem skipCommentRun (breaks : UInt8 → Bool) (bytes : List UInt8) (cursor : CommentCursor)
    (sound : ∀ byte, breaks byte = true → lineBreakStart byte = true)
    (safe : cursor.newline = true ∨ bytes.all (fun byte => !lineBreakStart byte) = true) :
    bytes.foldl (commentStep breaks) cursor =
      { position := cursor.position + bytes.length, newline := cursor.newline } := by
  induction bytes generalizing cursor with
  | nil => cases cursor; simp
  | cons byte rest inductionHypothesis =>
    have unchanged : (commentStep breaks cursor byte).newline = cursor.newline := by
      cases safe with
      | inl seen => simp [commentStep, seen]
      | inr plain =>
        simp only [List.all_cons, Bool.and_eq_true, Bool.not_eq_true'] at plain
        have quiet : breaks byte = false := by
          cases flag : breaks byte with
          | false => rfl
          | true => rw [sound byte flag] at plain; exact absurd plain.1 (by simp)
        simp [commentStep, quiet]
    have rest_safe : (commentStep breaks cursor byte).newline = true ∨
        rest.all (fun byte => !lineBreakStart byte) = true := by
      cases safe with
      | inl seen => exact Or.inl (by rw [unchanged, seen])
      | inr plain =>
        simp only [List.all_cons, Bool.and_eq_true] at plain
        exact Or.inr plain.2
    rw [List.foldl_cons, inductionHypothesis _ rest_safe, unchanged]
    simp [commentStep, Nat.add_assoc, Nat.add_comm 1]

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

theorem projectionLookupGroups (index : BitVec 8) :
    ((index &&& 240) == 0 || (index &&& 240) == 16) = decide (index < 32) := by
  bv_decide

theorem projectionMaskSuffix (mask : BitVec 64) (first lane stride : Nat) :
    (mask >>> (first * stride)).getLsbD (lane * stride) =
      mask.getLsbD ((first + lane) * stride) := by
  simp [Nat.add_mul]

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

-- Source-map SIMD seek run: 16 pure ASCII bytes without LF/CR preserve `line` and advance
-- both `offset` and UTF-16 `column` by 16.
def asciiLinePlain (byte : UInt8) : Bool :=
  byte < 128 && byte != 10 && byte != 13

structure MapPoint where
  offset : Nat
  line : Nat
  column : Nat

def mapSeekStep (point : MapPoint) (byte : UInt8) : MapPoint :=
  if asciiLinePlain byte then { point with offset := point.offset + 1, column := point.column + 1 }
  else point

theorem skipAsciiLineBlock (bytes : List UInt8) (point : MapPoint)
    (width : bytes.length = 16) (safe : bytes.all asciiLinePlain = true) :
    bytes.foldl mapSeekStep point = { point with offset := point.offset + 16, column := point.column + 16 } := by
  have go : ∀ (xs : List UInt8) (p : MapPoint), xs.all asciiLinePlain = true →
      xs.foldl mapSeekStep p = { p with offset := p.offset + xs.length, column := p.column + xs.length } := by
    intro xs
    induction xs with
    | nil => intro p _; cases p; simp
    | cons b rest ih =>
      intro p h
      simp only [List.all_cons, Bool.and_eq_true] at h
      rw [List.foldl_cons, ih _ h.2]
      cases p
      simp [mapSeekStep, h.1, Nat.add_comm, Nat.add_left_comm]
  rw [go bytes point safe, width]

-- Template-literal static text scan: bytes other than `` ` `` (96), `$` (36), and `\` (92)
-- only advance `offset` by 1 and leave every other parser-state field untouched.
-- Scope: proves prefix-skip equivalence for already-classified safe bytes; SIMD mask
-- extraction, first-stop-lane selection, and 16-byte bounds are verified exhaustively
-- in `native/pulse/test.c`.
def templatePlain (byte : UInt8) : Bool :=
  byte != 96 && byte != 36 && byte != 92

theorem skipTemplateRun (bytes : List UInt8) (offset : Nat)
    (safe : bytes.all templatePlain = true) :
    bytes.foldl (fun pos b => if templatePlain b then pos + 1 else pos) offset = offset + bytes.length := by
  induction bytes generalizing offset with
  | nil => simp
  | cons b rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at safe
    rw [List.foldl_cons, if_pos safe.1, ih (offset + 1) safe.2]
    simp only [List.length_cons]
    omega

-- Whitespace run in `trivia_from`: skipping spaces/tabs/LF/CR advances `position` by the count
-- and sets `newline` iff `cursor.newline` was already true or any skipped byte is LF/CR.
-- Scope: same prefix-skip abstraction as `skipTemplateRun`; SIMD lane masks and
-- newline-before-stop filtering are verified exhaustively in `native/pulse/test.c`.
def asciiSpace (byte : UInt8) : Bool :=
  byte == 32 || byte == 9 || byte == 10 || byte == 13

def asciiLineEnd (byte : UInt8) : Bool :=
  byte == 10 || byte == 13

theorem skipSpaceRun (bytes : List UInt8) (cursor : CommentCursor)
    (safe : bytes.all asciiSpace = true) :
    bytes.foldl (commentStep asciiLineEnd) cursor =
      { position := cursor.position + bytes.length,
        newline := cursor.newline || bytes.any asciiLineEnd } := by
  induction bytes generalizing cursor with
  | nil => cases cursor; simp
  | cons b rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at safe
    rw [List.foldl_cons, ih _ safe.2]
    cases cursor
    simp [commentStep, Bool.or_assoc, Nat.add_assoc, Nat.add_comm 1]

-- Variable-length prefix skip for `tmt_ascii_line_count`, `tmt_map_blank_count`, and
-- `tmt_map_word_count`: any prefix `bytes` whose elements all satisfy `asciiLinePlain`
-- advances `offset` and `column` by `bytes.length` without changing `line`.
theorem skipAsciiLinePrefix (bytes : List UInt8) (point : MapPoint)
    (safe : bytes.all asciiLinePlain = true) :
    bytes.foldl mapSeekStep point =
      { point with offset := point.offset + bytes.length, column := point.column + bytes.length } := by
  induction bytes generalizing point with
  | nil => cases point; simp
  | cons b rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at safe
    rw [List.foldl_cons, ih _ safe.2]
    cases point
    simp only [mapSeekStep, safe.1, ↓reduceIte, List.length_cons]
    congr 1 <;> omega

-- ASCII identifier-continue run (`[A-Za-z0-9_$]`) for `tmt_ident_run` in `TmtPulseScan_scan_class`.
-- Scope: proves prefix-skip equivalence for already-classified identifier bytes; SIMD lane masks
-- and 16-byte bounds are verified exhaustively in `native/pulse/test.c`.
def asciiIdentContinue (byte : UInt8) : Bool :=
  (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) ||
  (byte >= 48 && byte <= 57) || byte == 95 || byte == 36

theorem skipIdentRun (bytes : List UInt8) (offset : Nat)
    (safe : bytes.all asciiIdentContinue = true) :
    bytes.foldl (fun pos b => if asciiIdentContinue b then pos + 1 else pos) offset =
      offset + bytes.length := by
  induction bytes generalizing offset with
  | nil => simp
  | cons b rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at safe
    rw [List.foldl_cons, if_pos safe.1, ih (offset + 1) safe.2]
    simp only [List.length_cons]
    omega

-- Horizontal whitespace run (`' '` or `'\t'`) for `tmt_hspace_run` in `TmtPulseScan_scan_class`.
def asciiHorizontalSpace (byte : UInt8) : Bool :=
  byte == 32 || byte == 9

theorem skipHorizontalSpaceRun (bytes : List UInt8) (offset : Nat)
    (safe : bytes.all asciiHorizontalSpace = true) :
    bytes.foldl (fun pos b => if asciiHorizontalSpace b then pos + 1 else pos) offset =
      offset + bytes.length := by
  induction bytes generalizing offset with
  | nil => simp
  | cons b rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at safe
    rw [List.foldl_cons, if_pos safe.1, ih (offset + 1) safe.2]
    simp only [List.length_cons]
    omega

end CompilerRuns
