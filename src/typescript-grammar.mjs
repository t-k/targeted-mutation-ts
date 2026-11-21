export function createTypeScriptGrammar(ts, bindings) {
  const strictReservedBindings = new Set(['implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield']);
  const strictRestrictedBindings = new Set(['eval', 'arguments']);

  function checkStatementSyntax(file, module, strictRoot, emit) {
    const pending = [{
      node: file, parent: undefined, ambient: false, functionContext: false,
      runtimeParameters: false, forHead: '', strict: strictRoot, async: false,
    }];
    while (pending.length) {
      const { node, parent, ambient: parentAmbient, functionContext, runtimeParameters, forHead,
        strict: parentStrict, async: parentAsync } = pending.pop();
      const strict = strictScope(node, file, parentStrict);
      const async = ts.isFunctionLike(node)
        ? node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        : parentAsync;
      const ambient = parentAmbient || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword));
      const report = (message, at = node) => emit(at, message);
      let binding;
      if (
        ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isClassLike(node) ||
        ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isModuleDeclaration(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) ||
        ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node) ||
        ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.body) ||
        ((ts.isTypeParameterDeclaration(node) || ts.isParameter(node)) && runtimeParameters)
      ) binding = node.name;
      if (!ambient && binding && ts.isIdentifier(binding)) {
        const name = binding.text;
        if (strict && strictReservedBindings.has(name)) report(`'${name}' is reserved in strict mode and cannot be used as a binding identifier`, binding);
        else if (strict && strictRestrictedBindings.has(name)) report(`'${name}' is not allowed as a binding identifier in strict mode`, binding);
        else if (name === 'await' && (module || async)) report("'await' is reserved in an async/module context and cannot be used as a binding identifier", binding);
      }

      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(parent) && !ambient && !node.initializer && forHead !== 'iteration') {
        const destructured = ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name);
        if (forHead === 'classic') {
          if (destructured) report('Destructuring declaration in for loop initializer must be initialized');
          else if ((parent.flags & ts.NodeFlags.Const) !== 0) report("'const' declarations in for loop initializer must be initialized");
        } else if (destructured) report('Destructuring declaration must have an initializer');
        else if ((parent.flags & ts.NodeFlags.Const) !== 0) report("'const' declarations must be initialized");
      }

      if (strict && ts.isWithStatement(node)) report("'with' statements are not allowed in strict mode");
      if (ts.isReturnStatement(node) && !functionContext) report("'return' statement is only valid inside a function");
      const single = parent && (
        (ts.isIfStatement(parent) && (parent.thenStatement === node || parent.elseStatement === node)) ||
        ((ts.isIterationStatement(parent, true) || ts.isWithStatement(parent) || ts.isLabeledStatement(parent)) && parent.statement === node)
      );
      if (single) {
        if (ts.isClassDeclaration(node)) report('Class declarations are not allowed in single-statement contexts');
        if (ts.isFunctionDeclaration(node) && node.body && (strict || !ts.isIfStatement(parent) && !ts.isLabeledStatement(parent))) {
          report(strict ? 'In strict mode code, functions can only be declared at top level or inside a block' :
            'In non-strict mode code, functions can only be declared at top level, inside a block, or as the body of an if statement');
        }
        if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) {
          report('Lexical declaration cannot appear in a single-statement context');
        }
      }
      ts.forEachChild(node, child => {
        const loopHead = ts.isVariableDeclarationList(child) && node.initializer === child
          ? (ts.isForInOrOfStatement(node) ? 'iteration' : ts.isForStatement(node) ? 'classic' : '')
          : ts.isVariableDeclarationList(node) ? forHead : '';
        const childFunction = ts.isClassStaticBlockDeclaration(node) ? false : ts.isFunctionLike(node) && node.body === child ? true : functionContext;
        const childParameters = ts.isFunctionLike(node) ? !!node.body : runtimeParameters || ts.isClassLike(node) ||
          ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
        pending.push({
          node: child, parent: node, ambient, functionContext: childFunction, runtimeParameters: childParameters,
          forHead: loopHead, strict, async,
        });
      });
    }
  }


  function checkContexts(file, strictRoot, emit) {
    const pending = [{
      node: file, parent: undefined, loop: false, switch_: false, super_: 'none', labels: [],
      outerLabels: [], ambient: false, strict: strictRoot,
    }];
    function duplicates(names) {
      const seen = new Map();
      for (const name of names) {
        const first = seen.get(name.text);
        if (first) emit(name, `Identifier '${name.text}' has already been declared`, first);
        else seen.set(name.text, name);
      }
    }
    const isFunctionScope = node => ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
    function nestedAliases(statements) {
      const aliases = [];
      const pending = [...statements];
      while (pending.length) {
        const node = pending.pop();
        const add = child => {
          if (child && ts.isTypeAliasDeclaration(child)) aliases.push(child);
          else if (child && !ts.isBlock(child)) pending.push(child);
        };
        if (ts.isIfStatement(node)) { add(node.thenStatement); add(node.elseStatement); }
        else if (ts.isIterationStatement(node, false)) add(node.statement);
      }
      return aliases;
    }
    const isIteration = node => ts.isIterationStatement(node, false);
    const modifiersOf = node => ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const lexicalListNames = list => list?.declarations.flatMap(decl => bindings.namesIn(decl.name)) ?? [];
    while (pending.length) {
      const { node, parent, loop, switch_, super_, labels, outerLabels, ambient: parentAmbient,
        strict: parentStrict } = pending.pop();
      const report = (message, at = node) => emit(at, message);
      const strict = strictScope(node, file, parentStrict);
      const ambient = parentAmbient || modifiersOf(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword);
      if (ts.isFunctionLike(node)) {
        const ordinary = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
        if (strict || !ordinary || node.parameters.some(nonSimpleParameter)) {
          duplicates(node.parameters.flatMap(param => bindings.namesIn(param.name)));
        }
      }
      if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
        const statements = ts.isCaseBlock(node) ? node.clauses.flatMap(clause => [...clause.statements]) : [...node.statements];
        const params = parent && ts.isFunctionLike(parent) ? parent.parameters.flatMap(param => bindings.namesIn(param.name))
          : parent && ts.isCatchClause(parent) && parent.variableDeclaration ? bindings.namesIn(parent.variableDeclaration.name)
          : [];
        const catchPattern = parent && ts.isCatchClause(parent) && parent.variableDeclaration && !ts.isIdentifier(parent.variableDeclaration.name);
        const deep = statements.filter(statement => !ts.isVariableStatement(statement)).flatMap(bindings.nestedVarsIn);
        const parameters = catchPattern ? params : [...new Map(params.map(name => [name.text, name])).values()];
        bindings.checkScope([...statements, ...nestedAliases(statements)], emit, {
          parameters, catchPattern, nestedVars: deep, ambient,
        });
      }
      if (isIteration(node) && node.initializer && ts.isVariableDeclarationList(node.initializer) &&
          (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0) {
        const names = lexicalListNames(node.initializer);
        duplicates(names);
        const lexical = new Map(names.map(name => [name.text, name]));
        const nested = bindings.nestedVarsIn(node.statement);
        for (const name of nested) {
          const earlier = lexical.get(name.text);
          if (earlier) emit(name, `Identifier '${name.text}' has already been declared`, earlier);
        }
      }
      if (ts.isLabeledStatement(node)) {
        const name = node.label.text;
        if (strict && strictReservedBindings.has(name)) report(`'${name}' is reserved in strict mode and cannot be used as a label`, node.label);
        if (labels.some(label => label.name === name)) report(`Duplicate label '${name}'`);
      }
      if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
        if (node.label) {
          const name = node.label.text;
          if (strict && strictReservedBindings.has(name)) report(`'${name}' is reserved in strict mode and cannot be used as a label`, node.label);
          const target = labels.find(label => label.name === name);
          if (!target) {
            if (outerLabels.some(label => label.name === name)) {
              report(`Cannot ${ts.isBreakStatement(node) ? 'break' : 'continue'} to label '${name}' across function boundaries`);
            } else report(`Use of undefined label '${name}'`);
          }
          else if (!ts.isBreakStatement(node) && !target.iteration) report(`Label '${name}' does not denote an iteration statement`);
        } else if (!loop && (!ts.isBreakStatement(node) || !switch_)) {
          report(ts.isBreakStatement(node) ? 'Illegal break statement' : 'Illegal continue statement');
        }
      }
      if (ts.isImportDeclaration(node) && modifiersOf(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        report('An import declaration cannot have modifiers');
      }
      if (node.kind === ts.SyntaxKind.SuperKeyword && parent) {
        if (ts.isCallExpression(parent) && parent.expression === node && super_ !== 'constructor') {
          report("'super()' is only valid in a constructor of a derived class");
        } else if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node && super_ === 'none') {
          report("'super' property access is only valid inside a method or class body");
        }
      }
      ts.forEachChild(node, child => {
        const boundary = isFunctionScope(node);
        const childLoop = boundary ? false : isIteration(node) && node.statement === child ? true : loop;
        const childSwitch = boundary ? false : ts.isSwitchStatement(node) && node.caseBlock === child ? true : switch_;
        let childLabels = boundary ? [] : labels;
        if (ts.isLabeledStatement(node) && node.statement === child) {
          childLabels = [{ name: node.label.text, iteration: ts.isIterationStatement(child, true) }, ...labels];
        }
        let childSuper = super_;
        if (ts.isConstructorDeclaration(node) && child !== node.name) {
          const derived = parent && ts.isClassLike(parent) && parent.heritageClauses?.some(c => c.token === ts.SyntaxKind.ExtendsKeyword);
          childSuper = derived ? 'constructor' : 'property';
        } else if ((ts.isMethodDeclaration(node) || ts.isAccessor(node)) && child !== node.name) childSuper = 'property';
        else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) childSuper = 'none';
        else if (ts.isClassStaticBlockDeclaration(node) || (ts.isPropertyDeclaration(node) && child === node.initializer)) childSuper = 'property';
        pending.push({ node: child, parent: node, loop: childLoop, switch_: childSwitch, super_: childSuper, labels: childLabels,
          outerLabels: boundary ? [...labels, ...outerLabels] : outerLabels, ambient, strict });
      });
    }
  }


  function checkTypeSyntax(file, module, emit) {
    const pending = [{ node: file, parent: undefined }];
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, file.languageVariant, file.text);
    function tokenAt(at) {
      scanner.setTextPos(at);
      return scanner.scan() === ts.SyntaxKind.EndOfFileToken ? 'end of file' : scanner.getTokenText();
    }
    const modifiers = node => node.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.Decorator) ?? [];
    const propertyModifier = modifier => [
      ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword,
    ].includes(modifier.kind);
    while (pending.length) {
      const { node, parent } = pending.pop();
      const add = (message, at = node) => emit(at, message);
      if (node.typeParameters?.length === 0) add('A type parameter list cannot be empty');
      if (node.typeArguments?.length === 0) add('A type argument list cannot be empty');
      if (ts.isIndexSignatureDeclaration(node)) {
        if (module && node.parameters.some(param => ts.isIdentifier(param.name) && param.name.text === 'await')) {
          add("'await' is reserved in an async/module context and cannot be used as a binding identifier");
        }
        const key = node.parameters[0];
        if (modifiers(node).some(modifier => modifier.kind !== ts.SyntaxKind.ReadonlyKeyword) && parent && (ts.isInterfaceDeclaration(parent) || ts.isTypeLiteralNode(parent))) {
          add("Expected ';', ',', or newline between type members, but found '['");
        }
        if (key?.dotDotDotToken) add("Unexpected token '...'");
        else if (key?.questionToken) add("Unexpected token ':'");
        else if (key && modifiers(key).length) add(`Expected ']' to close a computed property key, but found '${key.name.getText(file)}'`);
        else if (key?.initializer) add("Expected ']' to close an index signature parameter list, but found '='");
        else if (node.parameters.length === 0) add("Unexpected token ']'");
        else if (node.parameters.length !== 1 || node.parameters.hasTrailingComma) add('An index signature must have exactly one parameter');
        else if (!node.type) {
          scanner.setTextPos(node.parameters.end);
          let kind = scanner.scan();
          if (kind === ts.SyntaxKind.CloseBracketToken) kind = scanner.scan();
          const token = kind === ts.SyntaxKind.EndOfFileToken ? 'end of file' : scanner.getTokenText();
          add(`Expected ':' after index signature parameters, but found '${token}'`);
        }
      }
      const nodeModifiers = modifiers(node);
      if (nodeModifiers.filter(flag => flag.kind === ts.SyntaxKind.ExportKeyword).length > 1) {
        add("Expected declaration after 'export', but found 'export'");
      }
      if (nodeModifiers.filter(flag => flag.kind === ts.SyntaxKind.DeclareKeyword).length > 1) {
        add("Expected a semicolon or an implicit semicolon after a statement, but found 'declare'");
      }
      if (ts.isCatchClause(node) && node.variableDeclaration?.initializer) {
        add("Expected ')' after catch parameter, but found '='");
      }
      if (ts.isEnumMember(node) && ts.isComputedPropertyName(node.name)) {
        add('Computed property names are not allowed in enums', node.name);
      }
      if (ts.isTupleTypeNode(node)) {
        let optional = false;
        for (const element of node.elements) {
          const currentOptional = ts.isOptionalTypeNode(element) || ts.isNamedTupleMember(element) && !!element.questionToken;
          const rest = ts.isRestTypeNode(element) || ts.isNamedTupleMember(element) && !!element.dotDotDotToken;
          if (optional && !currentOptional && !rest) add('A required element cannot follow an optional element');
          optional ||= currentOptional;
        }
      }
      if (ts.isParameter(node) && !ts.isIndexSignatureDeclaration(parent)) {
        const flags = modifiers(node);
        const constructor = ts.isConstructorDeclaration(parent);
        const isProperty = constructor && flags.length && flags.every(propertyModifier);
        if (isProperty && !ts.isIdentifier(node.name)) {
          add('A parameter property may not be declared using a binding pattern');
        }
        if (flags.length && node.dotDotDotToken) add("Unexpected token '...' in binding pattern");
        if (node.dotDotDotToken && parent.parameters.at(-1) !== node) add('Rest parameter must be the last parameter');
        if (node.dotDotDotToken && node.initializer) add("Expected ')' to close parameter list, but found '='");
        if (node.dotDotDotToken && parent.parameters.hasTrailingComma) add('Rest parameter may not have a trailing comma');
        if (node.dotDotDotToken && node.questionToken) add("Expected ')' to close parameter list, but found '?'");
        const invalid = flags.find(flag => !constructor || !propertyModifier(flag));
        if (invalid) {
          const token = tokenAt(invalid.end);
          if (ts.isArrowFunction(parent)) add(`Expected ',' or ')' in parenthesized expression, but found '${token}'`);
          else if (ts.isFunctionTypeNode(parent)) add(`Expected ')' to close a parenthesized type, but found '${token}'`);
          else add(`Expected ')' to close parameter list, but found '${token}'`);
        }
      }
      if (ts.isFunctionDeclaration(node)) {
        const firstAsync = nodeModifiers.findIndex(flag => flag.kind === ts.SyntaxKind.AsyncKeyword);
        const firstDeclare = nodeModifiers.findIndex(flag => flag.kind === ts.SyntaxKind.DeclareKeyword);
        if (firstAsync >= 0 && firstDeclare > firstAsync) {
          add(nodeModifiers.some(flag=>flag.kind === ts.SyntaxKind.ExportKeyword) ?
            "Expected 'function' keyword, but found 'declare'" :
            "Expected a semicolon or an implicit semicolon after a statement, but found 'declare'");
        }
      }
      if (node.templateFlags & ts.TokenFlags.ContainsInvalidEscape && parent && (ts.isTemplateLiteralTypeNode(parent) || ts.isLiteralTypeNode(parent) || ts.isTemplateLiteralTypeSpan(parent))) {
        add('Bad escape sequence in untagged template literal');
      }
      if (ts.isClassLike(node)) {
        const flags = modifiers(node);
        if (flags.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) && !flags.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          add("Expected 'class' keyword, but found 'default'");
        }
        const constructors = node.members.filter(member => ts.isConstructorDeclaration(member) && member.body && !modifiers(member).some(m => m.kind === ts.SyntaxKind.StaticKeyword));
        for (const duplicate of constructors.slice(1)) {
          add('A class can only have one constructor', duplicate.getFirstToken(file));
        }
        if (ts.isClassDeclaration(node) && !node.name && !modifiers(node).some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
          add('Class declaration requires a name');
        }
        let extendsSeen = false;
        let implementsSeen = false;
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            if (extendsSeen || implementsSeen) add("Expected '{' to start class body, but found 'extends'");
            if (clause.types.length > 1 || clause.types.hasTrailingComma) add("Expected '{' to start class body, but found ','");
            extendsSeen = true;
          } else {
            if (implementsSeen) add("Expected '{' to start class body, but found 'implements'");
            implementsSeen = true;
            for (const type of clause.types) {
              let expression = type.expression;
              while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
              if (expression.kind === ts.SyntaxKind.NullKeyword) {
                add("'null' is reserved and cannot be used as an identifier", expression);
              }
            }
          }
        }
      }
      if (ts.isInterfaceDeclaration(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token === ts.SyntaxKind.ImplementsKeyword) add("Expected '{' to start an interface body, but found 'implements'");
          for (const type of clause.types) {
            if (ts.isCallExpression(type.expression)) add("Expected '{' to start an interface body, but found '('");
            if (ts.isParenthesizedExpression(type.expression)) add("Expected an identifier, but found '('");
          }
        }
      }
      if (ts.isConstructorDeclaration(node)) {
        if (node.typeParameters?.length) add('Type parameters cannot appear on a constructor declaration');
        const field = nodeModifiers.find(flag => [ts.SyntaxKind.ConstKeyword, ts.SyntaxKind.InKeyword, ts.SyntaxKind.OutKeyword].includes(flag.kind));
        if (field) add(`Expected ';' after class field, but found '${tokenAt(field.end)}'`, field);
      }
      if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isAccessor(node)) &&
          nodeModifiers.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword)) {
        add("A 'readonly' modifier can only appear on a property declaration or index signature");
      }
      if (ts.isMappedTypeNode(node) && node.members?.length) {
        add(`Expected '}' to close a mapped type, but found '${node.members[0].name?.getText(file) ?? tokenAt(node.members.pos)}'`);
      }
      if ((ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.exclamationToken) {
        if (node.initializer) add('A declaration with an initializer cannot also have a definite assignment assertion');
        else if (!node.type) add('A declaration with a definite assignment assertion must also have a type annotation');
      }
      if (ts.isAccessor(node)) {
        const params = node.parameters.filter(param => param.name.getText(file) !== 'this');
        if (ts.isGetAccessorDeclaration(node) && params.length) add('Getter must have no parameters');
        if (ts.isSetAccessorDeclaration(node) && (params.length !== 1 || params[0].dotDotDotToken)) {
          add('Setter must have exactly one parameter');
        }
        if ((ts.isInterfaceDeclaration(parent) || ts.isTypeLiteralNode(parent)) && node.body) {
          add("Expected ';', ',', or newline between type members, but found '{'");
        }
      }
      if (ts.isPropertyDeclaration(node)) {
        if ((ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'constructor' &&
            nodeModifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) {
          add("Classes may not have a static field named 'constructor'", node.name);
        }
        const access = nodeModifiers.filter(flag => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.PrivateKeyword].includes(flag.kind));
        if (access.length > 1) add(`Expected ';' after class field, but found '${tokenAt(access[1].end)}'`);
        const unusual = nodeModifiers.find(flag => [ts.SyntaxKind.ConstKeyword, ts.SyntaxKind.ExportKeyword].includes(flag.kind));
        if (unusual) add(`Expected ';' after class field, but found '${tokenAt(unusual.end)}'`);
      }
      if (ts.isPropertySignature(node) && node.initializer) add("Expected ';', ',', or newline between type members, but found '='");
      if (parent && ts.isObjectLiteralExpression(parent)) {
        const firstModifier = modifiers(node).find(modifier =>
          modifier.kind !== ts.SyntaxKind.AsyncKeyword || !ts.isMethodDeclaration(node));
        if (firstModifier) add(`Expected ',' or '}' in object, but found '${tokenAt(firstModifier.end)}'`);
        if (node.questionToken) add("Expected ',' or '}' in object, but found '?'");
        if ((ts.isMethodDeclaration(node) || ts.isAccessor(node)) && !node.body) {
          scanner.setTextPos(node.getEnd());
          const last = file.text[node.getEnd() - 1];
          const unexpected = last === ';' ? ';' : tokenAt(node.getEnd());
          add(`Expected '{' to start function body, but found '${unexpected}'`);
        }
      }
      if (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isAccessor(node)) {
        const static_ = modifiers(node).some(m => m.kind === ts.SyntaxKind.StaticKeyword);
        if (static_ && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'prototype') {
          add("Classes may not have a static property named 'prototype'", node.name);
        }
        if (ts.isPropertyDeclaration(node) && node.exclamationToken && !node.type) {
          add('A declaration with a definite assignment assertion must also have a type annotation');
        }
      }
      if (ts.isArrowFunction(node)) {
        const beforeArrow = file.text.slice(node.parameters.end, node.equalsGreaterThanToken.pos);
        const safe = node.type ? file.text.slice(node.type.getEnd(), node.equalsGreaterThanToken.getStart(file)) :
          beforeArrow.slice(beforeArrow.lastIndexOf(')') + 1) + file.text.slice(node.equalsGreaterThanToken.pos, node.equalsGreaterThanToken.getStart(file));
        if (/[\r\n\u2028\u2029]/.test(safe)) {
          add("Expected '=>' on the same line after the arrow function parameters, but found '=>'");
        }
      }
      if (ts.isThrowStatement(node) && (!node.expression || node.expression.getWidth(file) === 0)) add('Illegal newline after throw');
      if (ts.isNewExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        add("'super' cannot be used as the target of 'new'");
      }
      if (ts.isBindingElement(node) && node.dotDotDotToken && node.propertyName && ts.isObjectBindingPattern(parent)) {
        add("Expected ',' or '}' in object, but found ':'");
      }
      if (ts.isBindingElement(node) && node.dotDotDotToken && node.initializer) add('A rest element cannot have an initializer');
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && !ts.isStringLiteral(node.moduleSpecifier)) {
        add(`Expected module specifier, but found '${node.moduleSpecifier.getText(file)}'`);
      }
      if (ts.isSwitchStatement(node) && node.caseBlock.clauses.filter(ts.isDefaultClause).length > 1) {
        add('A switch statement can only have one default clause');
      }
      if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxFragment(node.initializer) && parent && ts.isJsxAttributes(parent)) {
        const next = parent.properties[parent.properties.indexOf(node) + 1];
        if (next) add(`Expected '>' to close JSX opening element, but found '${next.name?.getText(file) ?? tokenAt(next.getStart(file))}'`);
      }
      if (ts.isJsxExpression(node) && ts.isJsxAttribute(parent) && !node.expression) add('JSX attribute value cannot be an empty expression');
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text !== 'target') {
        add("The only valid meta property for 'new' is 'new.target'");
      }
      if (ts.isEnumMember(node) && (ts.isNumericLiteral(node.name) || ts.isBigIntLiteral(node.name))) {
        add(`Unexpected token '${node.name.getText(file)}' as enum member name`);
      }
      if (ts.isRegularExpressionLiteral(node)) {
        const raw = node.getText(file);
        const flags = raw.slice(raw.lastIndexOf('/') + 1);
        const nonAscii = flags.search(/[^\x00-\x7F]/);
        if (nonAscii >= 0) {
          add(`Expected a semicolon or an implicit semicolon after a statement, but found '${flags.slice(nonAscii)}'`);
        }
        const ascii = nonAscii < 0 ? flags : flags.slice(0, nonAscii);
        if (/[^dgimsuvy]/.test(ascii)) add('Invalid regular expression flag');
        if (new Set(ascii).size !== ascii.length) add('Duplicate regular expression flag');
        if (ascii.includes('u') && ascii.includes('v')) add("The 'u' and 'v' regular expression flags cannot be used together");
      }
      if (ts.isImportTypeNode(node) && (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal))) {
        add(`Expected a string literal, but found '${node.argument.getText(file)}'`);
      }
      if (ts.isImportClause(node) && node.isTypeOnly && node.name && node.namedBindings) {
        add('A type-only import can specify a default import or named bindings, but not both');
      }
      if (ts.isImportAttribute(node) && !ts.isStringLiteral(node.value)) add('Import attribute value must be a string literal');
      if (ts.isImportDeclaration(node) && !ts.isSourceFile(parent) && !ts.isModuleBlock(parent)) {
        add("'import' declaration may only appear at the top level");
      }
      ts.forEachChild(node, child => { pending.push({node: child, parent: node}); });
    }
  }


  function checkPrivateNames(file, emit) {
    const pending = [{ node: file, parent: undefined, visible: new Set() }];
    while (pending.length) {
      const { node, parent, visible } = pending.pop();
      if (ts.isPrivateIdentifier(node) && parent && !visible.has(node.text)) {
        const access = ts.isPropertyAccessExpression(parent);
        const membership = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword;
        if (access || membership) emit(node, `Private field '${node.text}' must be declared in an enclosing class`);
      }
      const members = ts.isClassLike(node) ? new Set(node.members) : undefined;
      let inside = visible;
      if (members) {
        const privateMembers = new Map();
        for (const member of members) {
          if (!member.name || !ts.isPrivateIdentifier(member.name)) continue;
          const token = member.name;
          const accessor = ts.isGetAccessorDeclaration(member) ? 1 : ts.isSetAccessorDeclaration(member) ? 2 : 0;
          const isStatic = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false;
          const previous = privateMembers.get(token.text);
          if (token.text === '#constructor') emit(token, "Classes can't have a private field named '#constructor'");
          if (previous) {
            const pair = accessor !== 0 && previous.accessor !== 0 && (accessor & previous.accessor) === 0 &&
              previous.isStatic === isStatic;
            if (pair) previous.accessor |= accessor;
            else emit(token, `Duplicate private name '${token.text}'`, previous.token);
          } else privateMembers.set(token.text, { accessor, isStatic, token });
        }
        if (privateMembers.size) inside = new Set([...visible, ...privateMembers.keys()]);
      }
      ts.forEachChild(node, child => {
        pending.push({ node: child, parent: node, visible: members?.has(child) ? inside : visible });
      });
    }
  }

  function checkExpressionSyntax(file, module, strictRoot, emit) {
    const pending = [{ node: file, parent: undefined, canAwait: module, field: false, formal: false,
      canYield: false, ambient: false, assignmentPattern: false, forInitializer: false, strict: strictRoot, newTarget: false }];
    const modifiers = node => node.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.Decorator) ?? [];
    const hasModifier = (node, kind) => modifiers(node).some(modifier => modifier.kind === kind);
    const tokenAt = at => {
      scanner.setTextPos(at);
      return scanner.scan() === ts.SyntaxKind.EndOfFileToken ? 'end of file' : scanner.getTokenText();
    };
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, file.languageVariant, file.text);
    const isPlainAssignment = node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const isAssignmentTarget = node => ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
    const peelTarget = node => {
      while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) ||
          ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
        node = node.expression;
      }
      return node;
    };
    const isUpdateKind = kind => kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken;
    const isTypeLevel = parent => parent && (ts.isTypeNode(parent) || ts.isTypeParameterDeclaration(parent));
    const logical = new Set([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);
    const awaitMessage = "'await' is reserved in an async/module context and cannot be used as an identifier";
    const valueUse = (node, parent) => !isTypeLevel(parent) && !ts.isQualifiedName(parent) && (
      parent.expression === node || parent.left === node || parent.right === node || parent.operand === node ||
      parent.initializer === node || parent.condition === node || parent.whenTrue === node || parent.whenFalse === node ||
      parent.arguments?.includes(node) || ts.isArrayLiteralExpression(parent) ||
      ts.isArrowFunction(parent) && parent.body === node ||
      ts.isShorthandPropertyAssignment(parent) && parent.name === node
    );
    function checkTarget(root, patterns, strict) {
      const targets = [{ node: root, patterns }];
      while (targets.length) {
        const { node, patterns } = targets.pop();
        const target = peelTarget(node);
        if (ts.isOptionalChain(target)) {
          emit(target, 'Optional chaining is not allowed in assignment pattern');
          continue;
        }
        if (isAssignmentTarget(target)) {
          let unparenthesized = node;
          while (ts.isParenthesizedExpression(unparenthesized)) unparenthesized = unparenthesized.expression;
          if (strict && ts.isIdentifier(unparenthesized) && strictRestrictedBindings.has(unparenthesized.text)) {
            emit(unparenthesized, "Cannot assign to 'eval' or 'arguments' in strict mode");
          }
          continue;
        }
        const array = ts.isArrayLiteralExpression(target);
        const object = ts.isObjectLiteralExpression(target);
        if (ts.isParenthesizedExpression(node)) {
          emit(node, 'Parenthesized expression in assignment pattern must be a simple assignment target');
          continue;
        }
        if (!patterns || (!array && !object)) {
          emit(target, 'Invalid element in assignment pattern');
          continue;
        }
        const children = array ? target.elements : target.properties;
        for (const [index, child] of children.entries()) {
          if (ts.isOmittedExpression(child)) continue;
          if (ts.isSpreadElement(child) || ts.isSpreadAssignment(child)) {
            if (index !== children.length - 1) {
              emit(child, array ? 'Rest element must be the last element' : 'Rest element must be the last property');
            } else if (children.hasTrailingComma) {
              emit(child, `Rest element cannot have a trailing comma in ${array ? 'array' : 'object'} destructuring.`);
            }
            targets.push({ node: child.expression, patterns: array });
          } else if (array || ts.isPropertyAssignment(child) || ts.isShorthandPropertyAssignment(child)) {
            const value = array ? child : ts.isShorthandPropertyAssignment(child) ? child.name : child.initializer;
            targets.push({ node: isPlainAssignment(value) ? value.left : value, patterns: true });
          } else {
            emit(child, 'Invalid element in assignment pattern');
          }
        }
      }
    }
    while (pending.length) {
      const { node, parent, canAwait, field, formal, canYield, ambient: inheritedAmbient,
        assignmentPattern, forInitializer, strict: inheritedStrict, newTarget } = pending.pop();
      const strict = strictScope(node, file, inheritedStrict);
      const report = (message, at = node) => emit(at, message);
      const ambient = inheritedAmbient || hasModifier(node, ts.SyntaxKind.DeclareKeyword);
      if (ts.isAwaitExpression(node)) {
        if (formal) report('Await expression is not allowed in formal parameters');
        else if (!canAwait) {
          report(module ? awaitMessage :
            `Expected a semicolon or an implicit semicolon after a statement, but found '${tokenAt(node.expression.getStart(file))}'`);
        }
      }
      if (ts.isForOfStatement(node) && node.awaitModifier && !canAwait) {
        report("'for await' is only valid in async functions or modules");
      }
      if (ts.isYieldExpression(node) && formal) report('Yield expression is not allowed in formal parameters');
      else if (ts.isYieldExpression(node) && !canYield && node.expression) {
        report(`Expected a semicolon or an implicit semicolon after a statement, but found '${node.expression.getText(file)}'`);
      }
      if (ts.isIdentifier(node) && parent && valueUse(node, parent)) {
        const bare = ts.isExpressionStatement(parent);
        const call = ts.isCallExpression(parent) && parent.expression === node;
        if (strict && strictReservedBindings.has(node.text)) report(`'${node.text}' is reserved in strict mode and cannot be used as an identifier`);
        if (module && (bare || call) && node.text === 'await' && !canAwait) report(awaitMessage);
        if (field && node.text === 'arguments') {
          report("'arguments' is not allowed in class field initializers or static blocks");
        }
      }
      if (field && ts.isClassLike(node)) {
        const bases = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword);
        if (bases) {
          for (const base of bases.types) {
            let root = base.expression;
            while (ts.isPropertyAccessExpression(root)) root = root.expression;
            if (ts.isIdentifier(root) && root.text === 'arguments') {
              report("'arguments' is not allowed in class field initializers or static blocks", root);
            }
          }
        }
      }
      if (parent && ts.isStatement(node) && (ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
          hasModifier(node, ts.SyntaxKind.ExportKeyword))) {
        if (!ts.isSourceFile(parent) && !ts.isModuleBlock(parent)) report("'export' declaration may only appear at the top level");
        else if (!module && ts.isSourceFile(parent)) report("Cannot use 'export' declaration outside a module");
      }
      if (!module && ts.isImportDeclaration(node) && ts.isSourceFile(parent)) report("Cannot use 'import' declaration outside a module");
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text === 'target' && !newTarget) {
        report("'new.target' is only valid inside functions, class field initializers, or static blocks");
      }
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        if (!module && node.name.text === 'meta') report("'import.meta' is only valid in module code");
        if (!['meta','source','defer'].includes(node.name.text)) {
          report("The only valid meta properties for 'import' are 'import.meta', 'import.source()', or 'import.defer()'");
        }
      }
      if (ts.isForInOrOfStatement(node)) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          const { declarations } = node.initializer;
          if (declarations.length !== 1) {
            report('Only a single variable declaration is allowed in a for-in/of statement', node.initializer);
          }
          for (const declaration of declarations) {
            if (declaration.initializer) {
              report(`for-${ts.isForInStatement(node) ? 'in' : 'of'} loop variable declaration may not have an initializer`, declaration);
            }
          }
        } else {
          checkTarget(node.initializer, true, strict);
        }
      }
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const read = expression => ts.isBinaryExpression(expression) ? expression.operatorToken.kind : undefined;
        const nullish = ts.SyntaxKind.QuestionQuestionToken;
        if (op === ts.SyntaxKind.LessThanLessThanToken && ts.isAsExpression(node.left)) {
          let type = node.left.type;
          while (ts.isTypeOperatorNode(type)) type = type.type;
          if (ts.isImportTypeNode(type) && !type.typeArguments) {
            report("Expected '>' to close a type parameter list, but found ';'");
          }
        }
        if (op === nullish && [node.left,node.right].some(side => logical.has(read(side))) ||
            logical.has(op) && [node.left,node.right].some(side => read(side) === nullish)) {
          report('Logical expressions and nullish coalescing cannot be mixed');
        }
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
          checkTarget(node.left, op === ts.SyntaxKind.EqualsToken, strict);
        }
      }
      if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && isUpdateKind(node.operator)) {
        const operand = peelTarget(node.operand);
        if (!isAssignmentTarget(operand) || ts.isOptionalChain(operand)) report('Invalid operand for increment/decrement operator');
        else if (strict && ts.isIdentifier(operand) && strictRestrictedBindings.has(operand.text)) {
          report("Cannot assign to 'eval' or 'arguments' in strict mode");
        }
      }
      if (strict && ts.isDeleteExpression(node)) {
        let value = node.expression;
        while (ts.isParenthesizedExpression(value)) value = value.expression;
        if (ts.isIdentifier(value)) report('Deleting a variable in strict mode is not allowed');
      }
      if (!module && strict && ts.isNumericLiteral(node)) {
        const raw = node.getText(file);
        if (/^0[0-7]+$/.test(raw)) report('Octal literals are not allowed in strict mode');
        else if (/^0[0-9]+$/.test(raw)) report('Decimals with leading zeros are not allowed in strict mode');
      }
      if (!module && strict && ts.isStringLiteral(node)) {
        for (const [, legacy] of node.getText(file).matchAll(/\\(?:(0[0-9]|[1-9])|[\s\S])/g)) {
          if (legacy) {
            report('Legacy decimal and octal escape sequences are not allowed in strict mode');
            break;
          }
        }
      }
      if (ts.isVariableDeclarationList(node) && node.declarations.hasTrailingComma) {
        report(`Unexpected token '${tokenAt(node.getEnd())}' in binding pattern`);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!node.arguments.length) report("Unexpected token ')'");
        else if (ts.isSpreadElement(node.arguments[0])) report("Unexpected token '...'");
        else if (node.arguments.length > 2) report(`Expected ')' after import(), but found '${tokenAt(node.arguments[2].getStart(file))}'`);
      }
      if (ts.isArrowFunction(node) && forInitializer && ts.isBinaryExpression(node.body) &&
          node.body.operatorToken.kind === ts.SyntaxKind.InKeyword) {
        report("Expected ',' or ')' in parenthesized expression, but found 'in'");
      }
      if (ts.isTaggedTemplateExpression(node) && (node.questionDotToken || ts.isOptionalChain(node.tag))) {
        report('Tagged template expressions are not permitted in an optional chain');
      }
      if (ts.isObjectLiteralExpression(node) && !assignmentPattern) {
        const prototypes = node.properties.filter(p => ts.isPropertyAssignment(p) &&
          (ts.isStringLiteral(p.name) || ts.isIdentifier(p.name)) && p.name.text === '__proto__');
        if (prototypes.length > 1) report("Duplicate '__proto__' property in object literal");
      }
      if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        const rest = node.elements.findIndex(element => ts.isBindingElement(element) && element.dotDotDotToken);
        if (rest >= 0 && rest !== node.elements.length - 1 && ts.isObjectBindingPattern(node)) {
          report('Rest element must be the last property');
        }
        if (rest >= 0 && node.elements.hasTrailingComma && ts.isArrayBindingPattern(node)) {
          report('Rest element cannot have a trailing comma in array destructuring.');
        }
        if (rest >= 0 && rest !== node.elements.length - 1 && ts.isArrayBindingPattern(node)) {
          report('Rest element must be the last element', node.elements[rest]);
        }
      }
      if (parent && ts.isObjectLiteralExpression(parent) && node.name && ts.isPrivateIdentifier(node.name)) {
        report(`Expected ',' or '}' in object, but found '${node.name.text}'`, node.name);
      }
      if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer && !assignmentPattern) {
        report('Shorthand property cannot have a default value in object expression');
      }
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0 && !node.declarations.length) {
        report(`Unexpected token '${tokenAt(node.getEnd())}' in binding pattern`);
      }
      if (ts.isFunctionLike(node) && node.body && ambient && ts.isFunctionDeclaration(node)) {
        report('An implementation cannot be declared in ambient contexts');
      }
      if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body) &&
          node.parameters.some(nonSimpleParameter)) {
        for (const statement of node.body.statements) {
          if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
          if (['"use strict"', "'use strict'"].includes(statement.expression.getText(file))) {
            report("Illegal 'use strict' directive in function with non-simple parameter list", statement.expression);
            break;
          }
        }
      }
      if (ts.isStatement(node)) {
        scanner.setTextPos(node.getStart(file));
        const first = scanner.scan();
        const second = scanner.scan();
        const third = scanner.scan();
        if (first === ts.SyntaxKind.DeclareKeyword && second === ts.SyntaxKind.ExportKeyword) {
          report("Expected a semicolon or an implicit semicolon after a statement, but found 'export'");
        }
        if (first === ts.SyntaxKind.ExportKeyword && second === ts.SyntaxKind.DeclareKeyword && third === ts.SyntaxKind.ExportKeyword) {
          report("Expected declaration after 'export', but found 'declare'");
        }
        if (first === ts.SyntaxKind.ExportKeyword && second === ts.SyntaxKind.ExportKeyword) {
          report("Expected declaration after 'export', but found 'export'");
        }
      }
      ts.forEachChild(node, child => {
        const inField = ts.isClassStaticBlockDeclaration(node) || (ts.isPropertyDeclaration(node) && node.initializer === child);
        const fn = ts.isFunctionLike(node);
        const arrow = ts.isArrowFunction(node);
        const nextField = inField || (field && (!fn || arrow || node.name === child));
        const nextAwait = inField ? false : fn && node.name !== child ? hasModifier(node, ts.SyntaxKind.AsyncKeyword) : canAwait;
        const nextYield = inField ? false : fn && node.name !== child ? !!node.asteriskToken : canYield;
        const nextFormal = fn ? node.parameters.includes(child) : formal;
        const parentPattern = assignmentPattern && (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) ||
          ts.isParenthesizedExpression(node) || ts.isPropertyAssignment(node) && node.initializer === child ||
          ts.isSpreadAssignment(node) || ts.isSpreadElement(node));
        const nextPattern = parentPattern || (isPlainAssignment(node) && node.left === child) ||
          (ts.isForInOrOfStatement(node) && node.initializer === child);
        pending.push({node: child, parent: node, canAwait: nextAwait, field: nextField, formal: nextFormal,
          canYield: nextYield, ambient, assignmentPattern: nextPattern, strict,
          newTarget: inField || newTarget || fn && !arrow && node.name !== child,
          forInitializer: forInitializer || ts.isForStatement(node) && node.initializer === child});
      });
    }
  }

  function hasStrictDirective(statements, file) {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
      const text = statement.expression.getText(file);
      if (text === '"use strict"' || text === "'use strict'") return true;
    }
    return false;
  }

  function strictScope(node, file, inherited) {
    return inherited || ts.isClassLike(node) ||
      (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body) && hasStrictDirective(node.body.statements, file));
  }

  function nonSimpleParameter(parameter) {
    return parameter.dotDotDotToken || parameter.initializer || !ts.isIdentifier(parameter.name);
  }

  return function checkGrammar(file, mode, emit) {
    const module = mode !== 'script';
    const strict = module || hasStrictDirective(file.statements, file);
    checkExpressionSyntax(file, module, strict, emit);
    checkTypeSyntax(file, module, emit);
    checkContexts(file, strict, emit);
    checkStatementSyntax(file, module, strict, emit);
    checkPrivateNames(file, emit);
    const nestedVars = file.statements.filter(statement => !ts.isVariableStatement(statement)).flatMap(bindings.nestedVarsIn);
    bindings.checkScope(file.statements, emit, { nestedVars });
    bindings.checkNamespaceExports(file, emit);
    if (module) bindings.checkExports(file, emit, nestedVars);
  };
}
