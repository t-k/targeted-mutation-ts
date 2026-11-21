use std::collections::{HashMap, HashSet, hash_map::Entry};
use std::panic::catch_unwind;
use std::{ptr, slice, str};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    AccessorProperty, BinaryExpression, BindingIdentifier, Declaration, Expression, Function,
    Ident, IdentifierReference, JSXAttribute, JSXAttributeItem, JSXAttributeName,
    JSXAttributeValue, JSXExpression, JSXOpeningElement, MethodDefinition, MethodDefinitionKind,
    ModuleDeclaration, NewExpression, NumericLiteral, PropertyDefinition, PropertyKey, Statement,
    StringLiteral, TSClassImplements, TSExportAssignment, TSImportType, TSIndexSignature,
    TSMethodSignature, TSMethodSignatureKind, TSModuleBlock, TSTemplateLiteralType, UnaryExpression,
};
use oxc_ast::ast_kind::AstKind;
use oxc_ast_visit::{Visit, walk};
use oxc_parser::{Kind, ParseOptions, Parser, Token, config::TokensParserConfig};
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::module_record::{ExportExportName, ExportLocalName};
use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};
use oxc_syntax::scope::ScopeFlags;

#[repr(C)]
pub struct Candidate {
    operator: u32,
    edit: [u32; 2],
    left: [u32; 2],
    right: [u32; 2],
    expression: [u32; 2],
}

#[repr(C)]
pub struct ResultRows {
    rows: *mut Candidate,
    len: usize,
    ast_nodes: u32,
    max_depth: u32,
}

struct Collector<'a> {
    source: &'a str,
    tokens: &'a [Token],
    logical: bool,
    scoping: &'a Scoping,
    module_statements: HashSet<u32>,
    rows: Vec<Candidate>,
    depth: u32,
    max_depth: u32,
    rejected: bool,
}

fn bounds(span: Span) -> [u32; 2] {
    [span.start, span.end]
}

impl Collector<'_> {
    fn tokens_from(&self, position: u32) -> &[Token] {
        let start = self
            .tokens
            .partition_point(|token| token.start() < position);
        &self.tokens[start..]
    }

    fn has_modifier(&self, start: u32, key: Span, kinds: &[Kind]) -> bool {
        start < key.start
            && self
                .tokens_from(start)
                .iter()
                .take_while(|token| token.start() < key.start)
                .any(|token| kinds.contains(&token.kind()))
    }

    fn record(&mut self, text: &str, operator: u32, left: Span, right: Span, expression: Span) {
        let Some(token) = self.tokens_from(left.end).first() else {
            self.rejected = true;
            return;
        };
        if token.end() > right.start
            || self
                .source
                .get(token.start() as usize..token.end() as usize)
                != Some(text)
        {
            self.rejected = true;
            return;
        }
        self.rows.push(Candidate {
            operator,
            edit: bounds(token.span()),
            left: bounds(left),
            right: bounds(right),
            expression: bounds(expression),
        });
    }
}

fn static_prototype(is_static: bool, computed: bool, key: &PropertyKey<'_>) -> bool {
    is_static && !computed && key.is_specific_static_name("prototype")
}

fn restricted_identifier(name: &str) -> bool {
    matches!(
        name,
        "await"
            | "yield"
            | "let"
            | "static"
            | "implements"
            | "interface"
            | "package"
            | "private"
            | "protected"
            | "public"
    )
}

fn legacy_escape(raw: &str) -> bool {
    let mut bytes = raw.bytes().peekable();
    while let Some(byte) = bytes.next() {
        if byte == b'\\' {
            let escape = bytes.next();
            if matches!(escape, Some(b'1'..=b'9'))
                || (escape == Some(b'0') && matches!(bytes.peek(), Some(b'0'..=b'9')))
            {
                return true;
            }
        }
    }
    false
}

impl<'a> Visit<'a> for Collector<'_> {
    fn enter_node(&mut self, _node: AstKind<'a>) {
        self.depth += 1;
        self.max_depth = self.max_depth.max(self.depth);
    }

    fn leave_node(&mut self, _node: AstKind<'a>) {
        self.depth -= 1;
    }

    fn visit_binding_identifier(&mut self, node: &BindingIdentifier<'a>) {
        let name = node.name.as_str();
        self.rejected |= restricted_identifier(name) || matches!(name, "eval" | "arguments");
    }

    fn visit_identifier_reference(&mut self, node: &IdentifierReference<'a>) {
        let name = node.name.as_str();
        let restricted_write = matches!(name, "eval" | "arguments")
            && node
                .reference_id
                .get()
                .is_some_and(|id| self.scoping.get_reference(id).is_write());
        self.rejected |= restricted_identifier(name) || restricted_write;
    }

    fn visit_numeric_literal(&mut self, node: &NumericLiteral<'a>) {
        self.rejected |= node
            .raw
            .is_some_and(|raw| matches!(raw.as_bytes(), [b'0', b'0'..=b'9', ..]));
    }

    fn visit_string_literal(&mut self, node: &StringLiteral<'a>) {
        self.rejected |= node.raw.is_some_and(|raw| legacy_escape(raw.as_str()));
    }

    fn visit_unary_expression(&mut self, node: &UnaryExpression<'a>) {
        self.rejected |= node.operator == UnaryOperator::Delete
            && matches!(
                node.argument.without_parentheses(),
                Expression::Identifier(_)
            );
        walk::walk_unary_expression(self, node);
    }

    fn visit_statement(&mut self, node: &Statement<'a>) {
        self.rejected |= node.as_module_declaration().is_some()
            && !self.module_statements.contains(&node.span().start);
        walk::walk_statement(self, node);
    }

    fn visit_ts_module_block(&mut self, node: &TSModuleBlock<'a>) {
        self.module_statements
            .extend(node.body.iter().filter_map(|statement| {
                statement
                    .as_module_declaration()
                    .filter(|declaration| declaration.is_export())
                    .map(|_| statement.span().start)
            }));
        walk::walk_ts_module_block(self, node);
    }

    fn visit_ts_export_assignment(&mut self, _node: &TSExportAssignment<'a>) {
        self.rejected = true;
    }

    fn visit_ts_template_literal_type(&mut self, node: &TSTemplateLiteralType<'a>) {
        self.rejected |= node.quasis.len() != node.types.len() + 1;
        walk::walk_ts_template_literal_type(self, node);
    }

    fn visit_ts_class_implements(&mut self, node: &TSClassImplements<'a>) {
        self.rejected |= self
            .tokens_from(node.expression.span().start)
            .first()
            .is_some_and(|token| {
                let kind = token.kind();
                kind != Kind::This
                    && (kind.is_reserved_keyword() || kind.is_strict_mode_contextual_keyword())
            });
        walk::walk_ts_class_implements(self, node);
    }

    fn visit_ts_index_signature(&mut self, node: &TSIndexSignature<'a>) {
        let kind = Kind::match_keyword(node.parameter.name.as_str());
        self.rejected |= kind != Kind::Yield && kind.is_reserved_keyword();
        walk::walk_ts_index_signature(self, node);
    }

    fn visit_ts_method_signature(&mut self, node: &TSMethodSignature<'a>) {
        if node.kind != TSMethodSignatureKind::Method {
            self.rejected |= self.has_modifier(node.span.start, node.key.span(), &[Kind::Readonly]);
        }
        walk::walk_ts_method_signature(self, node);
    }

    fn visit_method_definition(&mut self, node: &MethodDefinition<'a>) {
        let start = node
            .decorators
            .last()
            .map_or(node.span.start, |decorator| decorator.span.end);
        let invalid: &[Kind] = match node.kind {
            MethodDefinitionKind::Constructor => &[Kind::Default, Kind::Const, Kind::In, Kind::Out],
            MethodDefinitionKind::Get | MethodDefinitionKind::Set => {
                &[Kind::Default, Kind::Readonly]
            }
            MethodDefinitionKind::Method => &[Kind::Default],
        };
        self.rejected |= self.has_modifier(start, node.key.span(), invalid);
        self.rejected |= static_prototype(node.r#static, node.computed, &node.key);
        walk::walk_method_definition(self, node);
    }

    fn visit_property_definition(&mut self, node: &PropertyDefinition<'a>) {
        let start = node
            .decorators
            .last()
            .map_or(node.span.start, |decorator| decorator.span.end);
        self.rejected |= self.has_modifier(start, node.key.span(), &[Kind::Default]);
        self.rejected |= static_prototype(node.r#static, node.computed, &node.key);
        walk::walk_property_definition(self, node);
    }

    fn visit_accessor_property(&mut self, node: &AccessorProperty<'a>) {
        self.rejected |= static_prototype(node.r#static, node.computed, &node.key);
        walk::walk_accessor_property(self, node);
    }

    fn visit_function(&mut self, node: &Function<'a>, flags: ScopeFlags) {
        // Yuku requires the ambient modifier to precede async.
        if node.declare
            && node.r#async
            && let [first, second, ..] = self.tokens_from(node.span.start)
            && first.kind() == Kind::Async
            && second.kind() == Kind::Declare
            && !second.is_on_new_line()
        {
            self.rejected = true;
        }
        walk::walk_function(self, node, flags);
    }

    fn visit_ts_import_type(&mut self, node: &TSImportType<'a>) {
        // Yuku can attach an angle list to an import type across a line terminator.
        self.rejected |= node.type_arguments.is_none()
            && self
                .tokens_from(node.span.end)
                .first()
                .is_some_and(|token| {
                    token.is_on_new_line() && matches!(token.kind(), Kind::LAngle | Kind::ShiftLeft)
                });
        walk::walk_ts_import_type(self, node);
    }

    fn visit_new_expression(&mut self, node: &NewExpression<'a>) {
        // Yuku requires parentheses before using an import expression as a constructor.
        self.rejected |= self
            .tokens_from(node.span.start)
            .get(1)
            .is_some_and(|token| token.kind() == Kind::Import);
        walk::walk_new_expression(self, node);
    }

    fn visit_binary_expression(&mut self, node: &BinaryExpression<'a>) {
        let operator = match node.operator {
            BinaryOperator::LessThan => Some(("<", 1)),
            BinaryOperator::LessEqualThan => Some(("<=", 2)),
            BinaryOperator::GreaterThan => Some((">", 3)),
            BinaryOperator::GreaterEqualThan => Some((">=", 4)),
            _ => None,
        };
        if let Some((text, code)) = operator {
            self.record(text, code, node.left.span(), node.right.span(), node.span);
        }
        walk::walk_binary_expression(self, node);
    }

    fn visit_jsx_opening_element(&mut self, node: &JSXOpeningElement<'a>) {
        // Yuku diagnoses a named attribute immediately following a bare JSX fragment.
        self.rejected |= node.attributes.windows(2).any(|pair| {
            matches!(
                (&pair[0], &pair[1]),
                (JSXAttributeItem::Attribute(left), JSXAttributeItem::Attribute(_))
                    if matches!(&left.value, Some(JSXAttributeValue::Fragment(_)))
            )
        });
        walk::walk_jsx_opening_element(self, node);
    }

    fn visit_jsx_attribute(&mut self, node: &JSXAttribute<'a>) {
        if self.logical
            && let JSXAttributeName::Identifier(name) = &node.name
            && name.name == "disabled"
            && let Some(JSXAttributeValue::ExpressionContainer(value)) = &node.value
            && let JSXExpression::LogicalExpression(expression) = &value.expression
            && expression.operator == LogicalOperator::Or
        {
            self.record(
                "||",
                5,
                expression.left.span(),
                expression.right.span(),
                expression.span,
            );
        }
        walk::walk_jsx_attribute(self, node);
    }
}

// Count possible recursion sites before calling the external recursive parser.
// This also counts punctuation and words inside trivia and strings on purpose.
fn within_budget(source: &str) -> bool {
    const LIMIT: usize = 16_384;
    const RECURSIVE_WORDS: [&[u8]; 14] = [
        b"as",
        b"await",
        b"delete",
        b"infer",
        b"in",
        b"instanceof",
        b"keyof",
        b"new",
        b"readonly",
        b"satisfies",
        b"typeof",
        b"unique",
        b"void",
        b"yield",
    ];
    let bytes = source.as_bytes();
    let mut sites = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(
            byte,
            b'(' | b'{'
                | b'['
                | b'.'
                | b'<'
                | b'>'
                | b'='
                | b'?'
                | b'+'
                | b'-'
                | b'*'
                | b'%'
                | b'/'
                | b'!'
                | b'~'
                | b'&'
                | b'|'
                | b'^'
                | b','
                | b':'
        ) || (byte.is_ascii_lowercase()
            && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric())
            && RECURSIVE_WORDS.iter().any(|word| {
                bytes[index..].starts_with(word)
                    && !bytes.get(index + word.len()).is_some_and(|next| {
                        next.is_ascii_alphanumeric() || matches!(next, b'_' | b'$')
                    })
            }))
        {
            sites += 1;
            if sites > LIMIT {
                return false;
            }
        }
    }
    true
}

fn parse(source: &str, tsx: bool, logical: bool) -> Option<(Vec<Candidate>, u32, u32)> {
    let source_type = if tsx {
        SourceType::tsx()
    } else {
        SourceType::ts()
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type.with_module(true))
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .with_config(TokensParserConfig)
        .parse();
    if parsed.fatal_error || parsed.is_flow_language || !parsed.diagnostics.is_empty() {
        return None;
    }
    let checked = SemanticBuilder::new_compiler().build(&parsed.program);
    if !checked.diagnostics.is_empty() {
        return None;
    }

    // TypeScript permits certain merges and assignments that the reference parser rejects.
    let scoping = checked.semantic.scoping();
    for id in scoping.symbol_ids() {
        let declarations = scoping.symbol_redeclarations(id);
        if declarations
            .iter()
            .any(|declaration| !declaration.flags.is_function())
        {
            return None;
        }
    }
    let record = &parsed.module_record;
    let bindings = scoping.get_bindings(scoping.root_scope_id());
    for entry in &record.local_export_entries {
        if let ExportLocalName::Name(local) = &entry.local_name
            && !bindings.contains_key::<Ident>(&local.name.into())
        {
            return None;
        }
    }
    let exported_functions: HashMap<_, _> = parsed
        .program
        .body
        .iter()
        .filter_map(|statement| {
            if let Statement::ExportDeclaration(export) = statement
                && let Declaration::FunctionDeclaration(function) = &export.declaration
            {
                return Some((export.span.start, function.body.is_some()));
            }
            None
        })
        .collect();
    let mut exported = HashMap::new();
    for entry in record
        .local_export_entries
        .iter()
        .chain(&record.indirect_export_entries)
    {
        let name = match &entry.export_name {
            ExportExportName::Name(name) => name.name.as_str(),
            ExportExportName::Default(_) => "default",
            ExportExportName::Null => continue,
        };
        let implementation = exported_functions.get(&entry.statement_span.start).copied();
        match exported.entry(name) {
            Entry::Vacant(entry) => {
                entry.insert(implementation);
            }
            Entry::Occupied(mut entry) => {
                // Direct overload signatures can share an export with at most one body.
                match (*entry.get(), implementation) {
                    (Some(previous), Some(current)) if !(previous && current) => {
                        entry.insert(Some(previous || current));
                    }
                    _ => return None,
                }
            }
        }
    }

    let mut collector = Collector {
        source,
        tokens: parsed.tokens.as_slice(),
        logical,
        scoping,
        module_statements: parsed
            .program
            .body
            .iter()
            .filter_map(|statement| {
                statement
                    .as_module_declaration()
                    .map(ModuleDeclaration::span)
                    .map(|span| span.start)
            })
            .collect(),
        rows: Vec::new(),
        depth: 0,
        max_depth: 0,
        rejected: false,
    };
    collector.visit_program(&parsed.program);
    if collector.rejected {
        return None;
    }
    collector.rows.sort_unstable_by_key(|row| row.edit[0]);
    Some((
        collector.rows,
        checked.semantic.stats().nodes,
        collector.max_depth,
    ))
}

/// # Safety
/// The caller supplies a readable byte range of `size` bytes and a writable result pointer.
/// On success it must release the result exactly once through `tmt_syntax_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tmt_syntax_parse(
    source: *const u8,
    size: usize,
    tsx: bool,
    logical: bool,
    output: *mut ResultRows,
) -> bool {
    if output.is_null() || size > 1_048_576 || (source.is_null() && size != 0) {
        return false;
    }
    // SAFETY: C holds the source Buffer live for the synchronous call.
    let bytes = if size == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(source, size) }
    };
    let Ok(source) = str::from_utf8(bytes) else {
        return false;
    };
    if !within_budget(source) {
        return false;
    }
    // Node may call the addon from a worker with a small stack. The recursive parser
    // and both AST visitors run on a separate stack on the calling thread.
    let Ok(Some((rows, ast_nodes, max_depth))) =
        catch_unwind(|| stacker::grow(64 * 1024 * 1024, || parse(source, tsx, logical)))
    else {
        return false;
    };
    let rows = rows.into_boxed_slice();
    let len = rows.len();
    // SAFETY: C supplies the destination and owns the returned allocation on success.
    unsafe {
        output.write(ResultRows {
            rows: Box::into_raw(rows).cast(),
            len,
            ast_nodes,
            max_depth,
        });
    }
    true
}

/// # Safety
/// The pointer and length must come from one successful call to `tmt_syntax_parse`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tmt_syntax_free(rows: *mut Candidate, len: usize) {
    // SAFETY: The caller returns ownership of the original boxed slice.
    unsafe {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(rows, len)));
    }
}
