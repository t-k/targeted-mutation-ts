module TmtReference

open TmtGrammar
open FStar.List.Tot
module U32 = FStar.UInt32

type lexeme =
  | Export
  | Const
  | Ident : string -> span -> lexeme
  | Decimal : string -> span -> lexeme
  | LParen : span -> lexeme
  | RParen : span -> lexeme
  | Colon
  | NumberType
  | Equals
  | Arrow : newline_before:bool -> lexeme
  | LT : span -> lexeme
  | LE : span -> lexeme
  | GT : span -> lexeme
  | GE : span -> lexeme
  | JsxOpen
  | JsxClose
  | JsxIdent : string -> span -> lexeme
  | JsxString : string -> span -> lexeme
  | LBrace
  | RBrace
  | Semicolon

type expression =
  | ReadName : string -> span -> expression
  | ReadDecimal : string -> span -> expression
  | Group : span -> expression -> span -> expression
  | Compare : expression -> U32.t -> span -> expression -> expression

type attribute =
  | StringAttr : string -> span -> string -> span -> attribute
  | ExpressionAttr : string -> span -> expression -> attribute

type body =
  | Expression : expression -> body
  | Element : string -> span -> list attribute -> body

type initializer =
  | Value : body -> initializer
  | Function : span -> string -> span -> span -> body -> initializer

type file =
  | Empty
  | Declaration : exported:bool -> name:string -> span -> initializer -> file

type config = { jsx:bool; module_mode:bool; expr_fuel:nat; attr_fuel:nat }

let as_operator (token:lexeme) : option (U32.t * span) =
  match token with
  | LT p -> Some (1ul, p)
  | LE p -> Some (2ul, p)
  | GT p -> Some (3ul, p)
  | GE p -> Some (4ul, p)
  | _ -> None

noeq type algebra (a:Type) = {
  read_name : string -> span -> a;
  read_decimal : string -> span -> a;
  group : span -> a -> span -> a;
  compare : a -> U32.t -> span -> a -> a
}

let rec parse_atom (#a:Type) (alg:algebra a) (fuel:nat) (tokens:list lexeme)
  : Tot (option (a * list lexeme)) (decreases %[fuel; 0])
  = match tokens with
    | Ident name p :: rest -> Some (alg.read_name name p, rest)
    | Decimal text p :: rest -> Some (alg.read_decimal text p, rest)
    | LParen open_pos :: rest ->
      if fuel = 0 then None
      else (match parse_expr alg (fuel - 1) rest with
            | Some (inner, RParen close_pos :: rest) -> Some (alg.group open_pos inner close_pos, rest)
            | _ -> None)
    | _ -> None
and parse_expr (#a:Type) (alg:algebra a) (fuel:nat) (tokens:list lexeme)
  : Tot (option (a * list lexeme)) (decreases %[fuel; 1])
  = match parse_atom alg fuel tokens with
    | None -> None
    | Some (left, token :: rest) ->
      (match as_operator token with
       | None -> Some (left, token :: rest)
       | Some (op, p) ->
         (match parse_atom alg fuel rest with
          | Some (right, tail) -> Some (alg.compare left op p right, tail)
          | None -> None))
    | Some (left, []) -> Some (left, [])

noeq type file_algebra (e:Type) (a:Type) (b:Type) (i:Type) (f:Type) = {
  expressions : algebra e;
  attr_string : string -> span -> string -> span -> a;
  attr_expr : string -> span -> e -> a;
  body_expr : e -> b;
  element : string -> span -> list a -> b;
  value : b -> i;
  arrow : span -> string -> span -> span -> b -> i;
  empty : f;
  declaration : bool -> string -> span -> i -> f
}

let rec parse_attrs (#e #a #b #i #f:Type) (alg:file_algebra e a b i f)
  (fuel:nat) (depth:nat) (tokens:list lexeme) : Tot (option (list a * list lexeme)) (decreases fuel)
  = match tokens with
    | JsxClose :: rest -> Some ([], rest)
    | JsxIdent name pos :: Equals :: JsxString text text_pos :: rest ->
      if fuel = 0 then None
      else (match parse_attrs alg (fuel - 1) depth rest with
            | Some (attrs, tail) -> Some (alg.attr_string name pos text text_pos :: attrs, tail)
            | None -> None)
    | JsxIdent name pos :: Equals :: LBrace :: rest ->
      if fuel = 0 then None
      else (match parse_expr alg.expressions depth rest with
            | Some (expr, RBrace :: next) ->
              (match parse_attrs alg (fuel - 1) depth next with
               | Some (attrs, tail) -> Some (alg.attr_expr name pos expr :: attrs, tail)
               | None -> None)
            | _ -> None)
    | _ -> None

let parse_body (#e #a #b #i #f:Type) (alg:file_algebra e a b i f) (cfg:config)
  (tokens:list lexeme) : option (b * list lexeme)
  = match tokens with
    | JsxOpen :: JsxIdent tag p :: rest ->
      if not cfg.jsx then None
      else (match parse_attrs alg cfg.attr_fuel cfg.expr_fuel rest with
            | Some (attrs, tail) -> Some (alg.element tag p attrs, tail)
            | None -> None)
    | _ ->
      (match parse_expr alg.expressions cfg.expr_fuel tokens with
       | Some (expr, rest) -> Some (alg.body_expr expr, rest)
       | None -> None)

let parse_init (#e #a #b #i #f:Type) (alg:file_algebra e a b i f) (cfg:config)
  (tokens:list lexeme) : option (i * list lexeme)
  = match tokens with
    | LParen p :: Ident name n :: Colon :: NumberType :: RParen q :: Arrow false :: rest ->
      (match parse_body alg cfg rest with
       | Some (result, tail) -> Some (alg.arrow p name n q result, tail)
       | None -> None)
    | _ ->
      (match parse_body alg cfg tokens with
       | Some (result, rest) -> Some (alg.value result, rest)
       | None -> None)

let parse_decl (#e #a #b #i #f:Type) (alg:file_algebra e a b i f)
  (cfg:config) (exported:bool) (tokens:list lexeme) : option f
  = match tokens with
    | Const :: Ident name p :: Equals :: rest ->
      (match parse_init alg cfg rest with
       | Some (result, []) | Some (result, [Semicolon]) -> Some (alg.declaration exported name p result)
       | _ -> None)
    | _ -> None

let parse_file (#e #a #b #i #f:Type) (alg:file_algebra e a b i f)
  (cfg:config) (tokens:list lexeme) : option f
  = match tokens with
    | [] -> Some alg.empty
    | Export :: rest -> if cfg.module_mode then parse_decl alg cfg true rest else None
    | _ -> parse_decl alg cfg false tokens

let reference_algebra : file_algebra expression attribute body initializer file = {
  expressions = { read_name = ReadName; read_decimal = ReadDecimal; group = Group; compare = Compare };
  attr_string = StringAttr; attr_expr = ExpressionAttr;
  body_expr = Expression; element = Element; value = Value; arrow = Function;
  empty = Empty; declaration = Declaration
}

let rec expression_span (expr:expression) : span =
  match expr with
  | ReadName _ p | ReadDecimal _ p -> p
  | Group p _ q -> { first = p.first; last = q.last }
  | Compare left _ _ right -> { first = (expression_span left).first; last = (expression_span right).last }

let rec collect_expression (expr:expression) : list candidate =
  match expr with
  | ReadName _ _ | ReadDecimal _ _ -> []
  | Group _ child _ -> collect_expression child
  | Compare left op p right ->
    collect_expression left @ [make_candidate op p (expression_span left) (expression_span right)] @ collect_expression right

let collect_attribute (attr:attribute) : list candidate =
  match attr with
  | StringAttr _ _ _ _ -> []
  | ExpressionAttr _ _ expr -> collect_expression expr

let collect (tree:file) : list candidate =
  match tree with
  | Empty -> []
  | Declaration _ _ _ (Value (Expression expr))
  | Declaration _ _ _ (Function _ _ _ _ (Expression expr)) -> collect_expression expr
  | Declaration _ _ _ (Value (Element _ _ attrs))
  | Declaration _ _ _ (Function _ _ _ _ (Element _ _ attrs)) -> concatMap collect_attribute attrs

type summary = { range:span; candidates:list candidate }

let summarise (expr:expression) : summary = { range = expression_span expr; candidates = collect_expression expr }

let atom_summary (p:span) : summary = { range = p; candidates = [] }

let grouped (open_pos:span) (inner:summary) (close_pos:span) : summary =
  { inner with range = { first = open_pos.first; last = close_pos.last } }

let compared (left:summary) (op:U32.t) (p:span) (right:summary) : summary = {
  range = { first = left.range.first; last = right.range.last };
  candidates = left.candidates @ [make_candidate op p left.range right.range] @ right.candidates
}

let compact_algebra : file_algebra summary (list candidate) (list candidate) (list candidate) (list candidate) = {
  expressions = { read_name = (fun _ p -> atom_summary p); read_decimal = (fun _ p -> atom_summary p);
    group = grouped; compare = compared };
  attr_string = (fun _ _ _ _ -> []); attr_expr = (fun _ _ expr -> expr.candidates);
  body_expr = (fun expr -> expr.candidates); element = (fun _ _ attrs -> concatMap (fun x -> x) attrs);
  value = (fun candidates -> candidates); arrow = (fun _ _ _ _ candidates -> candidates);
  empty = []; declaration = (fun _ _ _ candidates -> candidates)
}

let reference (cfg:config) (tokens:list lexeme) : option (list candidate) =
  match parse_file reference_algebra cfg tokens with
  | None -> None
  | Some ast -> Some (collect ast)

let fast_model (cfg:config) (tokens:list lexeme) : option (list candidate) =
  parse_file compact_algebra cfg tokens

let map_value (#a #b:Type) (f:a -> b) (r:option (a * list lexeme)) : option (b * list lexeme) =
  match r with
  | None -> None
  | Some (x, rest) -> Some (f x, rest)

#push-options "--fuel 3 --ifuel 2 --z3rlimit 30"

let rec atom_equivalence (fuel:nat) (tokens:list lexeme) : Lemma
  (ensures parse_atom compact_algebra.expressions fuel tokens ==
    map_value summarise (parse_atom reference_algebra.expressions fuel tokens))
  (decreases %[fuel; 0])
  = match tokens with
    | LParen p :: rest ->
      if fuel > 0 then (
        expression_equivalence (fuel - 1) rest;
        match parse_expr reference_algebra.expressions (fuel - 1) rest with
        | Some (_, RParen _ :: _) -> ()
        | _ -> ()
      )
    | Ident _ _ :: _ | Decimal _ _ :: _ -> ()
    | _ -> ()
and expression_equivalence (fuel:nat) (tokens:list lexeme) : Lemma
  (ensures parse_expr compact_algebra.expressions fuel tokens ==
    map_value summarise (parse_expr reference_algebra.expressions fuel tokens))
  (decreases %[fuel; 1])
  = atom_equivalence fuel tokens;
    match parse_atom reference_algebra.expressions fuel tokens with
    | Some (_, token :: rest) ->
      (match as_operator token with
       | Some (_, _) -> atom_equivalence fuel rest
       | None -> ())
    | _ -> ()

let rec attributes_equivalence (fuel:nat) (depth:nat) (tokens:list lexeme) : Lemma
  (ensures parse_attrs compact_algebra fuel depth tokens ==
    map_value (map collect_attribute) (parse_attrs reference_algebra fuel depth tokens))
  (decreases fuel)
  = match tokens with
    | JsxIdent _ _ :: Equals :: JsxString _ _ :: rest ->
      if fuel > 0 then attributes_equivalence (fuel - 1) depth rest
    | JsxIdent _ _ :: Equals :: LBrace :: rest ->
      if fuel > 0 then (
        expression_equivalence depth rest;
        match parse_expr reference_algebra.expressions depth rest with
        | Some (_, RBrace :: next) -> attributes_equivalence (fuel - 1) depth next
        | _ -> ()
      )
    | _ -> ()

let collect_body (tree:body) : list candidate =
  match tree with
  | Expression expr -> collect_expression expr
  | Element _ _ attrs -> concatMap collect_attribute attrs

let rec flatten_attributes (attrs:list attribute) : Lemma
  (ensures concatMap (fun (x:list candidate) -> x) (map collect_attribute attrs) == concatMap collect_attribute attrs)
  (decreases attrs)
  = match attrs with | [] -> () | _ :: tail -> flatten_attributes tail

let body_equivalence (cfg:config) (tokens:list lexeme) : Lemma
  (ensures parse_body compact_algebra cfg tokens == map_value collect_body (parse_body reference_algebra cfg tokens))
  = match tokens with
    | JsxOpen :: JsxIdent _ _ :: rest ->
      if cfg.jsx then (
        attributes_equivalence cfg.attr_fuel cfg.expr_fuel rest;
        match parse_attrs reference_algebra cfg.attr_fuel cfg.expr_fuel rest with
        | Some (attrs, _) -> flatten_attributes attrs
        | None -> ()
      )
    | _ -> expression_equivalence cfg.expr_fuel tokens

let collect_initializer (tree:initializer) : list candidate =
  match tree with | Value expr | Function _ _ _ _ expr -> collect_body expr

let initializer_equivalence (cfg:config) (tokens:list lexeme) : Lemma
  (ensures parse_init compact_algebra cfg tokens == map_value collect_initializer (parse_init reference_algebra cfg tokens))
  = match tokens with
    | LParen _ :: Ident _ _ :: Colon :: NumberType :: RParen _ :: Arrow false :: rest -> body_equivalence cfg rest
    | _ -> body_equivalence cfg tokens

let declaration_equivalence (cfg:config) (exported:bool) (tokens:list lexeme) : Lemma
  (ensures parse_decl compact_algebra cfg exported tokens ==
    (match parse_decl reference_algebra cfg exported tokens with | None -> None | Some ast -> Some (collect ast)))
  = match tokens with
    | Const :: Ident _ _ :: Equals :: rest ->
      initializer_equivalence cfg rest;
      (match parse_init reference_algebra cfg rest with
       | Some (Value (Expression _), _) | Some (Value (Element _ _ _), _)
       | Some (Function _ _ _ _ (Expression _), _) | Some (Function _ _ _ _ (Element _ _ _), _) | None -> ())
    | _ -> ()

let extraction_equivalence (cfg:config) (tokens:list lexeme) : Lemma
  (ensures fast_model cfg tokens == reference cfg tokens)
  = match tokens with
    | [] -> ()
    | Export :: rest -> if cfg.module_mode then declaration_equivalence cfg true rest
    | _ -> declaration_equivalence cfg false tokens

#pop-options

let valid_operator (o:U32.t) : bool = o = 1ul || o = 2ul || o = 3ul || o = 4ul

let print_operator (o:U32.t) (p:span) : lexeme =
  if o = 1ul then LT p else if o = 2ul then LE p else if o = 3ul then GT p else GE p

let rec print_expression (e:expression) : list lexeme =
  match e with
  | ReadName name p -> [Ident name p]
  | ReadDecimal text p -> [Decimal text p]
  | Group p child q -> [LParen p] @ print_expression child @ [RParen q]
  | Compare left op p right -> print_expression left @ [print_operator op p] @ print_expression right

let rec well_atom (fuel:nat) (e:expression) : Tot bool (decreases %[e; 0]) =
  match e with
  | ReadName _ _ | ReadDecimal _ _ -> true
  | Group _ child _ -> fuel > 0 && well_expression (fuel - 1) child
  | Compare _ _ _ _ -> false
and well_expression (fuel:nat) (e:expression) : Tot bool (decreases %[e; 1]) =
  match e with
  | Compare l o _ r -> well_atom fuel l && valid_operator o && well_atom fuel r
  | _ -> well_atom fuel e

let non_operator (tail:list lexeme) : bool =
  match tail with | [] -> true | x :: _ -> None? (as_operator x)

#push-options "--fuel 3 --ifuel 2 --z3rlimit 40"

let rec atom_complete (fuel:nat) (e:expression) (tail:list lexeme) : Lemma
  (requires well_atom fuel e)
  (ensures parse_atom reference_algebra.expressions fuel (print_expression e @ tail) == Some (e, tail))
  (decreases %[e; 0])
  = match e with
    | Group p child q ->
      append_assoc (print_expression child) [RParen q] tail;
      expression_complete (fuel - 1) child (RParen q :: tail)
    | _ -> ()
and expression_complete (fuel:nat) (e:expression) (tail:list lexeme) : Lemma
  (requires well_expression fuel e /\ non_operator tail)
  (ensures parse_expr reference_algebra.expressions fuel (print_expression e @ tail) == Some (e, tail))
  (decreases %[e; 1])
  = match e with
    | Compare left op p right ->
      append_assoc (print_expression left) ([print_operator op p] @ print_expression right) tail;
      atom_complete fuel left (print_operator op p :: (print_expression right @ tail));
      atom_complete fuel right tail
    | _ -> atom_complete fuel e tail

let rec print_attributes (attrs:list attribute) : list lexeme =
  match attrs with
  | [] -> [JsxClose]
  | StringAttr name p text q :: next ->
    JsxIdent name p :: Equals :: JsxString text q :: print_attributes next
  | ExpressionAttr name p e :: next ->
    JsxIdent name p :: Equals :: LBrace :: (print_expression e @ (RBrace :: print_attributes next))

let rec well_attributes (fuel:nat) (depth:nat) (attrs:list attribute) : Tot bool (decreases attrs) =
  match attrs with
  | [] -> true
  | StringAttr _ _ _ _ :: rest -> fuel > 0 && well_attributes (fuel - 1) depth rest
  | ExpressionAttr _ _ e :: rest -> fuel > 0 && well_expression depth e && well_attributes (fuel - 1) depth rest

let rec attributes_complete (fuel:nat) (depth:nat) (attrs:list attribute) (tail:list lexeme) : Lemma
  (requires well_attributes fuel depth attrs)
  (ensures parse_attrs reference_algebra fuel depth (print_attributes attrs @ tail) == Some (attrs, tail))
  (decreases attrs)
  = match attrs with
    | [] -> ()
    | StringAttr _ _ _ _ :: rest -> attributes_complete (fuel - 1) depth rest tail
    | ExpressionAttr name p e :: rest ->
      append_assoc (print_expression e) (RBrace :: print_attributes rest) tail;
      expression_complete depth e (RBrace :: (print_attributes rest @ tail));
      attributes_complete (fuel - 1) depth rest tail

let print_body (tree:body) : list lexeme =
  match tree with
  | Expression e -> print_expression e
  | Element name p attrs -> JsxOpen :: JsxIdent name p :: print_attributes attrs

let well_body (cfg:config) (tree:body) : bool =
  match tree with
  | Expression e -> well_expression cfg.expr_fuel e
  | Element _ _ attrs -> cfg.jsx && well_attributes cfg.attr_fuel cfg.expr_fuel attrs

let group_prefix (fuel:nat) (p:span) (child:expression) (q:span) (tail:list lexeme) : Lemma
  (requires well_atom fuel (Group p child q))
  (ensures (match print_expression (Group p child q) @ tail with
    | JsxOpen :: _ | LParen _ :: Ident _ _ :: Colon :: _ -> False
    | _ -> True))
  = append_assoc (print_expression child) [RParen q] tail;
      (match child with
       | Compare left op pos right ->
         append_assoc (print_expression left) ([print_operator op pos] @ print_expression right) (RParen q :: tail);
         (match left with
          | ReadName _ _ | ReadDecimal _ _ | Group _ _ _ -> ()
          | Compare _ _ _ _ -> ())
       | _ -> ())
let rec expression_prefix (fuel:nat) (e:expression) (tail:list lexeme) : Lemma
  (requires well_expression fuel e)
  (ensures (match print_expression e @ tail with
    | JsxOpen :: _ | LParen _ :: Ident _ _ :: Colon :: _ -> False
    | _ -> True))
  (decreases e)
  = match e with
    | Group p child q -> group_prefix fuel p child q tail
    | Compare left op pos right ->
      append_assoc (print_expression left) ([print_operator op pos] @ print_expression right) tail;
      expression_prefix fuel left (print_operator op pos :: (print_expression right @ tail))
    | _ -> ()

let body_complete (cfg:config) (tree:body) (tail:list lexeme) : Lemma
  (requires well_body cfg tree /\ non_operator tail)
  (ensures parse_body reference_algebra cfg (print_body tree @ tail) == Some (tree, tail))
  = match tree with
    | Expression e -> expression_prefix cfg.expr_fuel e tail; expression_complete cfg.expr_fuel e tail
    | Element _ _ attrs -> attributes_complete cfg.attr_fuel cfg.expr_fuel attrs tail

let print_init (tree:initializer) : list lexeme =
  match tree with
  | Value b -> print_body b
  | Function p name n q b -> [LParen p; Ident name n; Colon; NumberType; RParen q; Arrow false] @ print_body b

let well_init (cfg:config) (tree:initializer) : bool =
  match tree with | Value b | Function _ _ _ _ b -> well_body cfg b

let init_complete (cfg:config) (tree:initializer) (tail:list lexeme) : Lemma
  (requires well_init cfg tree /\ non_operator tail)
  (ensures parse_init reference_algebra cfg (print_init tree @ tail) == Some (tree, tail))
  = match tree with
    | Value b ->
      (match b with | Expression e -> expression_prefix cfg.expr_fuel e tail | _ -> ());
      body_complete cfg b tail
    | Function p name n q b ->
      assert_norm (print_init (Function p name n q b) @ tail ==
        LParen p :: Ident name n :: Colon :: NumberType :: RParen q :: Arrow false :: (print_body b @ tail));
      body_complete cfg b tail

let trailing (semicolon:bool) : list lexeme = if semicolon then [Semicolon] else []

let print_file (tree:file) (semicolon:bool) : list lexeme =
  match tree with
  | Empty -> []
  | Declaration exported name p rhs ->
    let decl = [Const; Ident name p; Equals] @ print_init rhs @ trailing semicolon in
    if exported then Export :: decl else decl

let in_l1_shape (cfg:config) (tree:file) : bool =
  match tree with
  | Empty -> true
  | Declaration exported _ _ rhs -> (not exported || cfg.module_mode) && well_init cfg rhs

let grammar_coverage (cfg:config) (tree:file) (semicolon:bool) : Lemma
  (requires in_l1_shape cfg tree)
  (ensures fast_model cfg (print_file tree semicolon) == Some (collect tree))
  = match tree with
    | Empty -> extraction_equivalence cfg (print_file tree semicolon)
    | Declaration exported name p rhs ->
      let tail = trailing semicolon in
      let rest = print_init rhs @ tail in
      init_complete cfg rhs tail;
      assert (tail == [] \/ tail == [Semicolon]);
      if exported then (
        assert_norm (print_file (Declaration true name p rhs) semicolon == Export :: Const :: Ident name p :: Equals :: rest)
      ) else (
        assert_norm (print_file (Declaration false name p rhs) semicolon == Const :: Ident name p :: Equals :: rest)
      );
      assert (parse_file reference_algebra cfg (print_file tree semicolon) == Some tree);
      extraction_equivalence cfg (print_file tree semicolon)

#pop-options
