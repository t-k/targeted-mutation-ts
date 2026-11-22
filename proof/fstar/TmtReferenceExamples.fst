module TmtReferenceExamples
#lang-pulse

open Pulse.Lib.Pervasives

open TmtReference
open FStar.List.Tot
module G = TmtGrammar
module U32 = FStar.UInt32

let span (first last:U32.t) : G.span = { G.first = first; G.last = last }

let badge_tokens = [
  Export; Const; Ident "Badge" (span 13ul 18ul); Equals;
  LParen (span 21ul 22ul); Ident "n" (span 22ul 23ul); Colon; NumberType; RParen (span 31ul 32ul); Arrow false;
  JsxOpen; JsxIdent "Tag" (span 37ul 40ul);
  JsxIdent "title" (span 41ul 46ul); Equals; JsxString "🐈 > 2" (span 47ul 57ul);
  JsxIdent "hi" (span 58ul 60ul); Equals; LBrace;
  Ident "n" (span 62ul 63ul); GE (span 72ul 74ul); Decimal "3" (span 75ul 76ul);
  RBrace; JsxClose
]

let tsx_module = { jsx = true; module_mode = true; expr_fuel = 64; attr_fuel = 4096 }

let exact_badge () : Lemma (reference tsx_module badge_tokens ==
  Some [G.make_candidate 4ul (span 72ul 74ul) (span 62ul 63ul) (span 75ul 76ul)]) =
  assert_norm (reference tsx_module badge_tokens ==
    Some [G.make_candidate 4ul (span 72ul 74ul) (span 62ul 63ul) (span 75ul 76ul)])

let reject_partial () : Lemma (reference tsx_module (badge_tokens @ [RBrace]) == None) =
  assert_norm (reference tsx_module (badge_tokens @ [RBrace]) == None)

// The lexer can run without binding or candidate workspace ownership.
fn source_only_trivia (input:TmtPulseMemory.tape) (start:U32.t)
  requires TmtPulseMemory.input_ready input
  returns result:TmtPulseParser.cursor
  ensures TmtPulseMemory.input_ready input
{
  TmtPulseParser.trivia input #emp start
}
