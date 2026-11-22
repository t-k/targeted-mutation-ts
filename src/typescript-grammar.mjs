export function createTypeScriptGrammar(ts, bindings) {
  const {
    NodeFlags, ScriptTarget, SyntaxKind, TokenFlags, canHaveModifiers, createScanner, forEachChild, getModifiers,
    isAccessor, isArrayBindingPattern, isArrayLiteralExpression, isArrowFunction, isAsExpression,
    isAwaitExpression, isBigIntLiteral, isBinaryExpression, isBindingElement, isBlock, isBreakStatement,
    isCallExpression, isCaseBlock, isCatchClause, isClassDeclaration, isClassLike, isClassStaticBlockDeclaration,
    isComputedPropertyName, isConstructorDeclaration, isContinueStatement, isDefaultClause, isDeleteExpression,
    isElementAccessExpression, isEnumDeclaration, isEnumMember, isExportAssignment, isExportDeclaration,
    isExpressionStatement, isForInOrOfStatement, isForInStatement, isForOfStatement, isForStatement,
    isFunctionDeclaration, isFunctionExpression, isFunctionLike, isFunctionTypeNode, isGetAccessorDeclaration,
    isIdentifier, isIfStatement, isImportAttribute, isImportClause, isImportDeclaration, isImportEqualsDeclaration,
    isImportSpecifier, isImportTypeNode, isIndexSignatureDeclaration, isInterfaceDeclaration, isIterationStatement,
    isJsxAttribute, isJsxAttributes, isJsxExpression, isJsxFragment, isLabeledStatement, isLiteralTypeNode,
    isMappedTypeNode, isMetaProperty, isMethodDeclaration, isMethodSignature, isModuleBlock, isModuleDeclaration,
    isNamedTupleMember, isNamespaceImport, isNewExpression, isNonNullExpression, isNumericLiteral,
    isObjectBindingPattern, isObjectLiteralExpression, isOmittedExpression, isOptionalChain, isOptionalTypeNode,
    isParameter, isParenthesizedExpression, isPostfixUnaryExpression, isPrefixUnaryExpression, isPrivateIdentifier,
    isPropertyAccessExpression, isPropertyAssignment, isPropertyDeclaration, isPropertySignature, isQualifiedName,
    isRegularExpressionLiteral, isRestTypeNode, isReturnStatement, isSatisfiesExpression, isSetAccessorDeclaration,
    isShorthandPropertyAssignment, isSourceFile, isSpreadAssignment, isSpreadElement, isStatement, isStringLiteral,
    isSwitchStatement, isTaggedTemplateExpression, isTemplateLiteralTypeNode, isTemplateLiteralTypeSpan,
    isThrowStatement, isTupleTypeNode, isTypeAliasDeclaration, isTypeAssertionExpression, isTypeLiteralNode,
    isTypeNode, isTypeOperatorNode, isTypeParameterDeclaration, isVariableDeclaration, isVariableDeclarationList,
    isVariableStatement, isWithStatement, isYieldExpression,
  } = ts;
  const strictReservedBindings = new Set(['implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield']);
  const strictRestrictedBindings = new Set(['eval', 'arguments']);
  const accessModifiers = new Set([SyntaxKind.PublicKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.PrivateKeyword]);
  const exclusiveModifiers = new Set([SyntaxKind.PublicKeyword, SyntaxKind.StaticKeyword, SyntaxKind.ReadonlyKeyword, SyntaxKind.OverrideKeyword]);
  const isInstanceConstructor = node => isConstructorDeclaration(node) &&
    !node.modifiers?.some(modifier => modifier.kind === SyntaxKind.StaticKeyword);

  function checkStatementSyntax(file, module, strictRoot, emit) {
    const pending = [{
      node: file, parent: undefined, ambient: false, functionContext: false,
      runtimeParameters: false, forHead: '', strict: strictRoot, async: false,
    }];
    while (pending.length) {
      const { node, parent, ambient: parentAmbient, functionContext, runtimeParameters, forHead,
        strict: parentStrict, async: parentAsync } = pending.pop();
      const strict = strictScope(node, file, parentStrict);
      const async = isFunctionLike(node)
        ? node.modifiers?.some(modifier => modifier.kind === SyntaxKind.AsyncKeyword)
        : parentAsync;
      const ambient = parentAmbient || (canHaveModifiers(node) && getModifiers(node)?.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword));
      const report = (message, at = node) => emit(at, message);
      let binding;
      if (
        isVariableDeclaration(node) || isBindingElement(node) || isClassLike(node) ||
        isEnumDeclaration(node) || isTypeAliasDeclaration(node) || isInterfaceDeclaration(node) ||
        isModuleDeclaration(node) || isImportClause(node) || isNamespaceImport(node) ||
        isImportSpecifier(node) || isImportEqualsDeclaration(node) ||
        ((isFunctionDeclaration(node) || isFunctionExpression(node)) && node.body) ||
        ((isTypeParameterDeclaration(node) || isParameter(node)) && runtimeParameters)
      ) binding = node.name;
      if (!ambient && binding && isIdentifier(binding)) {
        const name = binding.text;
        if (strict && strictReservedBindings.has(name)) report(`'${name}' is reserved in strict mode and cannot be used as a binding identifier`, binding);
        else if (strict && strictRestrictedBindings.has(name)) report(`'${name}' is not allowed as a binding identifier in strict mode`, binding);
        else if (name === 'await' && (module || async)) report("'await' is reserved in an async/module context and cannot be used as a binding identifier", binding);
      }

      if (isVariableDeclaration(node) && isVariableDeclarationList(parent) && !ambient && !node.initializer && forHead !== 'iteration') {
        const destructured = isObjectBindingPattern(node.name) || isArrayBindingPattern(node.name);
        if (forHead === 'classic') {
          if (destructured) report('Destructuring declaration in for loop initializer must be initialized');
          else if ((parent.flags & NodeFlags.Const) !== 0) report("'const' declarations in for loop initializer must be initialized");
        } else if (destructured) report('Destructuring declaration must have an initializer');
        else if ((parent.flags & NodeFlags.Const) !== 0) report("'const' declarations must be initialized");
      }

      if (strict && isWithStatement(node)) report("'with' statements are not allowed in strict mode");
      if (isReturnStatement(node) && !functionContext) report("'return' statement is only valid inside a function");
      const single = parent && (
        (isIfStatement(parent) && (parent.thenStatement === node || parent.elseStatement === node)) ||
        ((isIterationStatement(parent, true) || isWithStatement(parent) || isLabeledStatement(parent)) && parent.statement === node)
      );
      if (single) {
        if (isClassDeclaration(node)) report('Class declarations are not allowed in single-statement contexts');
        if (isFunctionDeclaration(node) && node.body && (strict || !isIfStatement(parent) && !isLabeledStatement(parent))) {
          report(strict ? 'In strict mode code, functions can only be declared at top level or inside a block' :
            'In non-strict mode code, functions can only be declared at top level, inside a block, or as the body of an if statement');
        }
        if (isVariableStatement(node) && (node.declarationList.flags & NodeFlags.BlockScoped) !== 0) {
          report('Lexical declaration cannot appear in a single-statement context');
        }
      }
      forEachChild(node, child => {
        const loopHead = isVariableDeclarationList(child) && node.initializer === child
          ? (isForInOrOfStatement(node) ? 'iteration' : isForStatement(node) ? 'classic' : '')
          : isVariableDeclarationList(node) ? forHead : '';
        const childFunction = isClassStaticBlockDeclaration(node) ? false : isFunctionLike(node) && node.body === child ? true : functionContext;
        const childParameters = isFunctionLike(node) ? !!node.body : runtimeParameters || isClassLike(node) ||
          isInterfaceDeclaration(node) || isTypeAliasDeclaration(node);
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
    const isFunctionScope = node => isFunctionLike(node) || isClassStaticBlockDeclaration(node);
    function nestedAliases(statements) {
      const aliases = [];
      const pending = [...statements];
      while (pending.length) {
        const node = pending.pop();
        const add = child => {
          if (child && isTypeAliasDeclaration(child)) aliases.push(child);
          else if (child && !isBlock(child)) pending.push(child);
        };
        if (isIfStatement(node)) { add(node.thenStatement); add(node.elseStatement); }
        else if (isIterationStatement(node, false)) add(node.statement);
      }
      return aliases;
    }
    const isIteration = node => isIterationStatement(node, false);
    const modifiersOf = node => canHaveModifiers(node) ? getModifiers(node) : undefined;
    const lexicalListNames = list => list?.declarations.flatMap(decl => bindings.namesIn(decl.name)) ?? [];
    while (pending.length) {
      const { node, parent, loop, switch_, super_, labels, outerLabels, ambient: parentAmbient,
        strict: parentStrict } = pending.pop();
      const report = (message, at = node) => emit(at, message);
      const strict = strictScope(node, file, parentStrict);
      const ambient = parentAmbient || modifiersOf(node)?.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword);
      if (isFunctionLike(node)) {
        const ordinary = isFunctionDeclaration(node) || isFunctionExpression(node);
        if (strict || !ordinary || node.parameters.some(nonSimpleParameter)) {
          duplicates(node.parameters.flatMap(param => bindings.namesIn(param.name)));
        }
      }
      if (isBlock(node) || isModuleBlock(node) || isCaseBlock(node)) {
        const statements = isCaseBlock(node) ? node.clauses.flatMap(clause => [...clause.statements]) : [...node.statements];
        const params = parent && isFunctionLike(parent) ? parent.parameters.flatMap(param => bindings.namesIn(param.name))
          : parent && isCatchClause(parent) && parent.variableDeclaration ? bindings.namesIn(parent.variableDeclaration.name)
          : [];
        const catchPattern = parent && isCatchClause(parent) && parent.variableDeclaration && !isIdentifier(parent.variableDeclaration.name);
        const deep = statements.filter(statement => !isVariableStatement(statement)).flatMap(bindings.nestedVarsIn);
        const parameters = catchPattern ? params : [...new Map(params.map(name => [name.text, name])).values()];
        bindings.checkScope([...statements, ...nestedAliases(statements)], emit, {
          parameters, catchPattern, nestedVars: deep, ambient,
        });
      }
      if (isIteration(node) && node.initializer && isVariableDeclarationList(node.initializer) &&
          (node.initializer.flags & NodeFlags.BlockScoped) !== 0) {
        const names = lexicalListNames(node.initializer);
        duplicates(names);
        const lexical = new Map(names.map(name => [name.text, name]));
        const nested = bindings.nestedVarsIn(node.statement);
        for (const name of nested) {
          const earlier = lexical.get(name.text);
          if (earlier) emit(name, `Identifier '${name.text}' has already been declared`, earlier);
        }
      }
      if (isLabeledStatement(node)) {
        const name = node.label.text;
        if (strict && strictReservedBindings.has(name)) report(`'${name}' is reserved in strict mode and cannot be used as a label`, node.label);
        if (labels.some(label => label.name === name)) report(`Duplicate label '${name}'`);
      }
      if (isBreakStatement(node) || isContinueStatement(node)) {
        if (node.label) {
          const name = node.label.text;
          if (strict && strictReservedBindings.has(name)) report(`'${name}' is reserved in strict mode and cannot be used as a label`, node.label);
          const target = labels.find(label => label.name === name);
          if (!target) {
            if (outerLabels.some(label => label.name === name)) {
              report(`Cannot ${isBreakStatement(node) ? 'break' : 'continue'} to label '${name}' across function boundaries`);
            } else report(`Use of undefined label '${name}'`);
          }
          else if (!isBreakStatement(node) && !target.iteration) report(`Label '${name}' does not denote an iteration statement`);
        } else if (!loop && (!isBreakStatement(node) || !switch_)) {
          report(isBreakStatement(node) ? 'Illegal break statement' : 'Illegal continue statement');
        }
      }
      if (isImportDeclaration(node) && modifiersOf(node)?.some(modifier => modifier.kind === SyntaxKind.ExportKeyword)) {
        report('An import declaration cannot have modifiers');
      }
      if (node.kind === SyntaxKind.SuperKeyword && parent) {
        if (isCallExpression(parent) && parent.expression === node && super_ !== 'constructor') {
          report("'super()' is only valid in a constructor of a derived class");
        } else if ((isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
            parent.expression === node && super_ === 'none') {
          report("'super' property access is only valid inside a method or class body");
        }
      }
      forEachChild(node, child => {
        const boundary = isFunctionScope(node);
        const childLoop = boundary ? false : isIteration(node) && node.statement === child ? true : loop;
        const childSwitch = boundary ? false : isSwitchStatement(node) && node.caseBlock === child ? true : switch_;
        let childLabels = boundary ? [] : labels;
        if (isLabeledStatement(node) && node.statement === child) {
          childLabels = [{ name: node.label.text, iteration: isIterationStatement(child, true) }, ...labels];
        }
        let childSuper = super_;
        if (isConstructorDeclaration(node) && child !== node.name) {
          const derived = isInstanceConstructor(node) && parent && isClassLike(parent) &&
            parent.heritageClauses?.some(c => c.token === SyntaxKind.ExtendsKeyword);
          childSuper = derived ? 'constructor' : 'property';
        } else if ((isMethodDeclaration(node) || isAccessor(node)) && child !== node.name) childSuper = 'property';
        else if (isFunctionDeclaration(node) || isFunctionExpression(node)) childSuper = 'none';
        else if (isClassStaticBlockDeclaration(node) || (isPropertyDeclaration(node) && child === node.initializer)) childSuper = 'property';
        pending.push({ node: child, parent: node, loop: childLoop, switch_: childSwitch, super_: childSuper, labels: childLabels,
          outerLabels: boundary ? [...labels, ...outerLabels] : outerLabels, ambient, strict });
      });
    }
  }


  function checkTypeSyntax(file, module, emit) {
    const pending = [{ node: file, parent: undefined }];
    const scanner = createScanner(ScriptTarget.Latest, true, file.languageVariant, file.text);
    function tokenAt(at) {
      scanner.setTextPos(at);
      return scanner.scan() === SyntaxKind.EndOfFileToken ? 'end of file' : scanner.getTokenText();
    }
    const modifiers = node => node.modifiers?.filter(modifier => modifier.kind !== SyntaxKind.Decorator) ?? [];
    const propertyModifier = modifier => [
      SyntaxKind.PublicKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.PrivateKeyword,
      SyntaxKind.ReadonlyKeyword, SyntaxKind.OverrideKeyword,
    ].includes(modifier.kind);
    while (pending.length) {
      const { node, parent } = pending.pop();
      const add = (message, at = node) => emit(at, message);
      if (node.typeParameters?.length === 0) add('A type parameter list cannot be empty');
      if (node.typeArguments?.length === 0) add('A type argument list cannot be empty');
      if (isIndexSignatureDeclaration(node)) {
        if (module && node.parameters.some(param => isIdentifier(param.name) && param.name.text === 'await')) {
          add("'await' is reserved in an async/module context and cannot be used as a binding identifier");
        }
        const key = node.parameters[0];
        if (modifiers(node).some(modifier => modifier.kind !== SyntaxKind.ReadonlyKeyword) && parent && (isInterfaceDeclaration(parent) || isTypeLiteralNode(parent))) {
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
          if (kind === SyntaxKind.CloseBracketToken) kind = scanner.scan();
          const token = kind === SyntaxKind.EndOfFileToken ? 'end of file' : scanner.getTokenText();
          add(`Expected ':' after index signature parameters, but found '${token}'`);
        }
      }
      const nodeModifiers = modifiers(node);
      if (nodeModifiers.filter(flag => flag.kind === SyntaxKind.ExportKeyword).length > 1) {
        add("Expected declaration after 'export', but found 'export'");
      }
      if (nodeModifiers.filter(flag => flag.kind === SyntaxKind.DeclareKeyword).length > 1) {
        add("Expected a semicolon or an implicit semicolon after a statement, but found 'declare'");
      }
      if (nodeModifiers.length > 1 && parent && isClassLike(parent)) {
        const seen = new Set();
        for (const modifier of nodeModifiers) {
          const group = accessModifiers.has(modifier.kind) ? SyntaxKind.PublicKeyword : modifier.kind;
          if (!exclusiveModifiers.has(group)) continue;
          if (seen.has(group)) {
            add(`Expected ';' after class field, but found '${tokenAt(modifier.end)}'`);
            break;
          }
          seen.add(group);
        }
      }
      if (isCatchClause(node) && node.variableDeclaration?.initializer) {
        add("Expected ')' after catch parameter, but found '='");
      }
      if (isEnumMember(node) && isComputedPropertyName(node.name)) {
        add('Computed property names are not allowed in enums', node.name);
      }
      if (isTupleTypeNode(node)) {
        let optional = false;
        for (const element of node.elements) {
          const currentOptional = isOptionalTypeNode(element) || isNamedTupleMember(element) && !!element.questionToken;
          const rest = isRestTypeNode(element) || isNamedTupleMember(element) && !!element.dotDotDotToken;
          if (optional && !currentOptional && !rest) add('A required element cannot follow an optional element');
          optional ||= currentOptional;
        }
      }
      if (isParameter(node) && !isIndexSignatureDeclaration(parent)) {
        const flags = modifiers(node);
        const constructor = isInstanceConstructor(parent);
        const isProperty = constructor && flags.length && flags.every(propertyModifier);
        if (isProperty && !isIdentifier(node.name)) {
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
          if (isArrowFunction(parent)) add(`Expected ',' or ')' in parenthesized expression, but found '${token}'`);
          else if (isFunctionTypeNode(parent)) add(`Expected ')' to close a parenthesized type, but found '${token}'`);
          else add(`Expected ')' to close parameter list, but found '${token}'`);
        }
      }
      if (isFunctionDeclaration(node)) {
        const firstAsync = nodeModifiers.findIndex(flag => flag.kind === SyntaxKind.AsyncKeyword);
        const firstDeclare = nodeModifiers.findIndex(flag => flag.kind === SyntaxKind.DeclareKeyword);
        if (firstAsync >= 0 && firstDeclare > firstAsync) {
          add(nodeModifiers.some(flag=>flag.kind === SyntaxKind.ExportKeyword) ?
            "Expected 'function' keyword, but found 'declare'" :
            "Expected a semicolon or an implicit semicolon after a statement, but found 'declare'");
        }
      }
      if (node.templateFlags & TokenFlags.ContainsInvalidEscape && parent && (isTemplateLiteralTypeNode(parent) || isLiteralTypeNode(parent) || isTemplateLiteralTypeSpan(parent))) {
        add('Bad escape sequence in untagged template literal');
      }
      if (isClassLike(node)) {
        const flags = modifiers(node);
        if (flags.some(m => m.kind === SyntaxKind.DefaultKeyword) && !flags.some(m => m.kind === SyntaxKind.ExportKeyword)) {
          add("Expected 'class' keyword, but found 'default'");
        }
        const constructors = node.members.filter(member => isConstructorDeclaration(member) && member.body && !modifiers(member).some(m => m.kind === SyntaxKind.StaticKeyword));
        for (const duplicate of constructors.slice(1)) {
          add('A class can only have one constructor', duplicate.getFirstToken(file));
        }
        if (isClassDeclaration(node) && !node.name && !modifiers(node).some(m => m.kind === SyntaxKind.DefaultKeyword)) {
          add('Class declaration requires a name');
        }
        let extendsSeen = false;
        let implementsSeen = false;
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token === SyntaxKind.ExtendsKeyword) {
            if (extendsSeen || implementsSeen) add("Expected '{' to start class body, but found 'extends'");
            if (!clause.types.length) {
              add(`Expected '{' to start class body, but found '${tokenAt(node.end)}'`, clause);
            }
            if (clause.types.length > 1 || clause.types.hasTrailingComma) add("Expected '{' to start class body, but found ','");
            extendsSeen = true;
          } else {
            if (implementsSeen) add("Expected '{' to start class body, but found 'implements'");
            implementsSeen = true;
            for (const type of clause.types) {
              let expression = type.expression;
              while (isPropertyAccessExpression(expression)) expression = expression.expression;
              if (expression.kind === SyntaxKind.NullKeyword) {
                add("'null' is reserved and cannot be used as an identifier", expression);
              }
            }
          }
        }
      }
      if (isInterfaceDeclaration(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token === SyntaxKind.ImplementsKeyword) add("Expected '{' to start an interface body, but found 'implements'");
          for (const type of clause.types) {
            if (isCallExpression(type.expression)) add("Expected '{' to start an interface body, but found '('");
            if (isParenthesizedExpression(type.expression)) add("Expected an identifier, but found '('");
          }
        }
      }
      if (isConstructorDeclaration(node)) {
        if (isInstanceConstructor(node)) {
          if (node.typeParameters?.length) add('Type parameters cannot appear on a constructor declaration');
          if (nodeModifiers.some(modifier => modifier.kind === SyntaxKind.AsyncKeyword)) add('Constructor cannot be async');
        }
        if (nodeModifiers.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword)) {
          add("A 'declare' modifier cannot appear on a class element of this kind");
        }
        const field = nodeModifiers.find(flag => [SyntaxKind.ConstKeyword, SyntaxKind.InKeyword, SyntaxKind.OutKeyword].includes(flag.kind));
        if (field) add(`Expected ';' after class field, but found '${tokenAt(field.end)}'`, field);
      }
      if ((isMethodDeclaration(node) || isMethodSignature(node) || isAccessor(node) || isConstructorDeclaration(node)) &&
          nodeModifiers.some(m => m.kind === SyntaxKind.ReadonlyKeyword)) {
        add("A 'readonly' modifier can only appear on a property declaration or index signature");
      }
      if (isMethodDeclaration(node) && parent && isClassLike(parent)) {
        if (nodeModifiers.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword)) {
          add("A 'declare' modifier cannot appear on a class element of this kind");
        }
        if (node.body && nodeModifiers.some(modifier => modifier.kind === SyntaxKind.AbstractKeyword)) {
          add('An abstract method cannot have an implementation');
        }
      }
      if (isMappedTypeNode(node) && node.members?.length) {
        add(`Expected '}' to close a mapped type, but found '${node.members[0].name?.getText(file) ?? tokenAt(node.members.pos)}'`);
      }
      if ((isPropertyDeclaration(node) || isVariableDeclaration(node)) && node.exclamationToken) {
        if (node.initializer) add('A declaration with an initializer cannot also have a definite assignment assertion');
        else if (!node.type) add('A declaration with a definite assignment assertion must also have a type annotation');
      }
      if (isAccessor(node)) {
        const params = node.parameters.filter(param => param.name.getText(file) !== 'this');
        const static_ = nodeModifiers.some(modifier => modifier.kind === SyntaxKind.StaticKeyword);
        if (nodeModifiers.some(modifier => modifier.kind === SyntaxKind.AsyncKeyword)) {
          add(`Expected '(' for method definition, but found '${node.name.getText(file)}'`, node.name);
        }
        if (nodeModifiers.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword)) {
          add("A 'declare' modifier cannot appear on a class element of this kind", node.name);
        }
        if (node.body && nodeModifiers.some(modifier => modifier.kind === SyntaxKind.AbstractKeyword)) {
          add('An abstract accessor cannot have an implementation', node.name);
        }
        if (parent && isClassLike(parent) && !static_ &&
            (isIdentifier(node.name) || isStringLiteral(node.name)) && node.name.text === 'constructor') {
          add("Constructor can't have get/set modifier", node.name);
        }
        if (isGetAccessorDeclaration(node) && params.length) add('Getter must have no parameters');
        if (isSetAccessorDeclaration(node) && (params.length !== 1 || params[0].dotDotDotToken)) {
          add('Setter must have exactly one parameter');
        }
        if ((isInterfaceDeclaration(parent) || isTypeLiteralNode(parent)) && node.body) {
          add("Expected ';', ',', or newline between type members, but found '{'");
        }
      }
      if (isPropertyDeclaration(node)) {
        if ((isIdentifier(node.name) || isStringLiteral(node.name)) && node.name.text === 'constructor' &&
            nodeModifiers.some(m => m.kind === SyntaxKind.StaticKeyword)) {
          add("Classes may not have a static field named 'constructor'", node.name);
        }
        if (node.initializer && nodeModifiers.some(modifier => modifier.kind === SyntaxKind.AbstractKeyword)) {
          add('An abstract property cannot have an initializer');
        }
        const unusual = nodeModifiers.find(flag => [SyntaxKind.ConstKeyword, SyntaxKind.ExportKeyword].includes(flag.kind));
        if (unusual) add(`Expected ';' after class field, but found '${tokenAt(unusual.end)}'`);
      }
      if (isPropertySignature(node) && node.initializer) add("Expected ';', ',', or newline between type members, but found '='");
      if (parent && isObjectLiteralExpression(parent)) {
        const firstModifier = modifiers(node).find(modifier =>
          modifier.kind !== SyntaxKind.AsyncKeyword || !isMethodDeclaration(node));
        if (firstModifier) add(`Expected ',' or '}' in object, but found '${tokenAt(firstModifier.end)}'`);
        if (node.questionToken) add("Expected ',' or '}' in object, but found '?'");
        if ((isMethodDeclaration(node) || isAccessor(node)) && !node.body) {
          scanner.setTextPos(node.getEnd());
          const last = file.text[node.getEnd() - 1];
          const unexpected = last === ';' ? ';' : tokenAt(node.getEnd());
          add(`Expected '{' to start function body, but found '${unexpected}'`);
        }
      }
      if (isPropertyDeclaration(node) || isMethodDeclaration(node) || isAccessor(node)) {
        const static_ = modifiers(node).some(m => m.kind === SyntaxKind.StaticKeyword);
        if (static_ && (isIdentifier(node.name) || isStringLiteral(node.name)) && node.name.text === 'prototype') {
          add("Classes may not have a static property named 'prototype'", node.name);
        }
        if (isPropertyDeclaration(node) && node.exclamationToken && !node.type) {
          add('A declaration with a definite assignment assertion must also have a type annotation');
        }
      }
      if (isArrowFunction(node)) {
        const beforeArrow = file.text.slice(node.parameters.end, node.equalsGreaterThanToken.pos);
        const safe = node.type ? file.text.slice(node.type.getEnd(), node.equalsGreaterThanToken.getStart(file)) :
          beforeArrow.slice(beforeArrow.lastIndexOf(')') + 1) + file.text.slice(node.equalsGreaterThanToken.pos, node.equalsGreaterThanToken.getStart(file));
        if (/[\r\n\u2028\u2029]/.test(safe)) {
          add("Expected '=>' on the same line after the arrow function parameters, but found '=>'");
        }
      }
      if (isThrowStatement(node) && (!node.expression || node.expression.getWidth(file) === 0)) add('Illegal newline after throw');
      if (isNewExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) {
        add("'super' cannot be used as the target of 'new'");
      }
      if (isBindingElement(node) && node.dotDotDotToken && node.propertyName && isObjectBindingPattern(parent)) {
        add("Expected ',' or '}' in object, but found ':'");
      }
      if (isBindingElement(node) && node.dotDotDotToken && node.initializer) add('A rest element cannot have an initializer');
      if (isExportDeclaration(node) && node.moduleSpecifier && !isStringLiteral(node.moduleSpecifier)) {
        add(`Expected module specifier, but found '${node.moduleSpecifier.getText(file)}'`);
      }
      if (isSwitchStatement(node) && node.caseBlock.clauses.filter(isDefaultClause).length > 1) {
        add('A switch statement can only have one default clause');
      }
      if (isJsxAttribute(node) && node.initializer && isJsxFragment(node.initializer) && parent && isJsxAttributes(parent)) {
        const next = parent.properties[parent.properties.indexOf(node) + 1];
        if (next) add(`Expected '>' to close JSX opening element, but found '${next.name?.getText(file) ?? tokenAt(next.getStart(file))}'`);
      }
      if (isJsxExpression(node) && isJsxAttribute(parent) && !node.expression) add('JSX attribute value cannot be an empty expression');
      if (isMetaProperty(node) && node.keywordToken === SyntaxKind.NewKeyword && node.name.text !== 'target') {
        add("The only valid meta property for 'new' is 'new.target'");
      }
      if (isEnumMember(node) && (isNumericLiteral(node.name) || isBigIntLiteral(node.name))) {
        add(`Unexpected token '${node.name.getText(file)}' as enum member name`);
      }
      if (isRegularExpressionLiteral(node)) {
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
      if (isImportTypeNode(node) && (!isLiteralTypeNode(node.argument) || !isStringLiteral(node.argument.literal))) {
        add(`Expected a string literal, but found '${node.argument.getText(file)}'`);
      }
      if (isImportClause(node) && node.isTypeOnly && node.name && node.namedBindings) {
        add('A type-only import can specify a default import or named bindings, but not both');
      }
      if (isImportAttribute(node) && !isStringLiteral(node.value)) add('Import attribute value must be a string literal');
      if (isImportDeclaration(node) && !isSourceFile(parent) && !isModuleBlock(parent)) {
        add("'import' declaration may only appear at the top level");
      }
      forEachChild(node, child => { pending.push({node: child, parent: node}); });
    }
  }


  function checkPrivateNames(file, emit) {
    const pending = [{ node: file, parent: undefined, visible: new Set() }];
    while (pending.length) {
      const { node, parent, visible } = pending.pop();
      if (isPrivateIdentifier(node) && parent && !visible.has(node.text)) {
        const access = isPropertyAccessExpression(parent);
        const membership = isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.InKeyword;
        if (access || membership) emit(node, `Private field '${node.text}' must be declared in an enclosing class`);
      }
      const members = isClassLike(node) ? new Set(node.members) : undefined;
      let inside = visible;
      if (members) {
        const privateMembers = new Map();
        for (const member of members) {
          if (!member.name || !isPrivateIdentifier(member.name)) continue;
          const token = member.name;
          const accessor = isGetAccessorDeclaration(member) ? 1 : isSetAccessorDeclaration(member) ? 2 : 0;
          const isStatic = member.modifiers?.some(modifier => modifier.kind === SyntaxKind.StaticKeyword) ?? false;
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
      forEachChild(node, child => {
        pending.push({ node: child, parent: node, visible: members?.has(child) ? inside : visible });
      });
    }
  }

  function checkExpressionSyntax(file, module, strictRoot, emit) {
    const pending = [{ node: file, parent: undefined, canAwait: module, field: false, formal: false,
      canYield: false, ambient: false, assignmentPattern: false, forInitializer: false, strict: strictRoot, newTarget: false }];
    const modifiers = node => node.modifiers?.filter(modifier => modifier.kind !== SyntaxKind.Decorator) ?? [];
    const hasModifier = (node, kind) => modifiers(node).some(modifier => modifier.kind === kind);
    const tokenAt = at => {
      scanner.setTextPos(at);
      return scanner.scan() === SyntaxKind.EndOfFileToken ? 'end of file' : scanner.getTokenText();
    };
    const scanner = createScanner(ScriptTarget.Latest, true, file.languageVariant, file.text);
    const isPlainAssignment = node => isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken;
    const isAssignmentTarget = node => isIdentifier(node) || isPropertyAccessExpression(node) || isElementAccessExpression(node);
    const peelTarget = node => {
      while (isParenthesizedExpression(node) || isNonNullExpression(node) || isAsExpression(node) ||
          isSatisfiesExpression(node) || isTypeAssertionExpression(node)) {
        node = node.expression;
      }
      return node;
    };
    const isUpdateKind = kind => kind === SyntaxKind.PlusPlusToken || kind === SyntaxKind.MinusMinusToken;
    const isTypeLevel = parent => parent && (isTypeNode(parent) || isTypeParameterDeclaration(parent));
    const logical = new Set([SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken]);
    const awaitMessage = "'await' is reserved in an async/module context and cannot be used as an identifier";
    const valueUse = (node, parent) => !isTypeLevel(parent) && !isQualifiedName(parent) && (
      parent.expression === node || parent.left === node || parent.right === node || parent.operand === node ||
      parent.initializer === node || parent.condition === node || parent.whenTrue === node || parent.whenFalse === node ||
      parent.arguments?.includes(node) || isArrayLiteralExpression(parent) ||
      isArrowFunction(parent) && parent.body === node ||
      isShorthandPropertyAssignment(parent) && parent.name === node
    );
    function checkTarget(root, patterns, strict) {
      const targets = [{ node: root, patterns }];
      while (targets.length) {
        const { node, patterns } = targets.pop();
        const target = peelTarget(node);
        if (isOptionalChain(target)) {
          emit(target, 'Optional chaining is not allowed in assignment pattern');
          continue;
        }
        if (isAssignmentTarget(target)) {
          let unparenthesized = node;
          while (isParenthesizedExpression(unparenthesized)) unparenthesized = unparenthesized.expression;
          if (strict && isIdentifier(unparenthesized) && strictRestrictedBindings.has(unparenthesized.text)) {
            emit(unparenthesized, "Cannot assign to 'eval' or 'arguments' in strict mode");
          }
          continue;
        }
        const array = isArrayLiteralExpression(target);
        const object = isObjectLiteralExpression(target);
        if (isParenthesizedExpression(node)) {
          emit(node, 'Parenthesized expression in assignment pattern must be a simple assignment target');
          continue;
        }
        if (!patterns || (!array && !object)) {
          emit(target, 'Invalid element in assignment pattern');
          continue;
        }
        const children = array ? target.elements : target.properties;
        for (const [index, child] of children.entries()) {
          if (isOmittedExpression(child)) continue;
          if (isSpreadElement(child) || isSpreadAssignment(child)) {
            if (index !== children.length - 1) {
              emit(child, array ? 'Rest element must be the last element' : 'Rest element must be the last property');
            } else if (children.hasTrailingComma) {
              emit(child, `Rest element cannot have a trailing comma in ${array ? 'array' : 'object'} destructuring.`);
            }
            targets.push({ node: child.expression, patterns: array });
          } else if (array || isPropertyAssignment(child) || isShorthandPropertyAssignment(child)) {
            const value = array ? child : isShorthandPropertyAssignment(child) ? child.name : child.initializer;
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
      const ambient = inheritedAmbient || hasModifier(node, SyntaxKind.DeclareKeyword);
      if (isAwaitExpression(node)) {
        if (formal) report('Await expression is not allowed in formal parameters');
        else if (!canAwait) {
          report(module ? awaitMessage :
            `Expected a semicolon or an implicit semicolon after a statement, but found '${tokenAt(node.expression.getStart(file))}'`);
        }
      }
      if (isForOfStatement(node) && node.awaitModifier && !canAwait) {
        report("'for await' is only valid in async functions or modules");
      }
      if (isYieldExpression(node) && formal) report('Yield expression is not allowed in formal parameters');
      else if (isYieldExpression(node) && !canYield && node.expression) {
        report(`Expected a semicolon or an implicit semicolon after a statement, but found '${node.expression.getText(file)}'`);
      } else if (isYieldExpression(node) && node.asteriskToken && node.expression) {
        const trivia = file.text.slice(node.asteriskToken.end, node.expression.getStart(file));
        if (/[\r\n\u2028\u2029]/.test(trivia)) report("Expected expression after 'yield*'", node.asteriskToken);
      }
      if (isIdentifier(node) && parent && valueUse(node, parent)) {
        const bare = isExpressionStatement(parent);
        const call = isCallExpression(parent) && parent.expression === node;
        if (strict && strictReservedBindings.has(node.text)) report(`'${node.text}' is reserved in strict mode and cannot be used as an identifier`);
        if (module && (bare || call) && node.text === 'await' && !canAwait) report(awaitMessage);
        if (field && node.text === 'arguments') {
          report("'arguments' is not allowed in class field initializers or static blocks");
        }
      }
      if (field && isClassLike(node)) {
        const bases = node.heritageClauses?.find(clause => clause.token === SyntaxKind.ExtendsKeyword);
        if (bases) {
          for (const base of bases.types) {
            let root = base.expression;
            while (isPropertyAccessExpression(root)) root = root.expression;
            if (isIdentifier(root) && root.text === 'arguments') {
              report("'arguments' is not allowed in class field initializers or static blocks", root);
            }
          }
        }
      }
      if (parent && isStatement(node) && (isExportDeclaration(node) || isExportAssignment(node) ||
          hasModifier(node, SyntaxKind.ExportKeyword))) {
        if (!isSourceFile(parent) && !isModuleBlock(parent)) report("'export' declaration may only appear at the top level");
        else if (!module && isSourceFile(parent)) report("Cannot use 'export' declaration outside a module");
      }
      if (!module && isImportDeclaration(node) && isSourceFile(parent)) report("Cannot use 'import' declaration outside a module");
      if (isMetaProperty(node) && node.keywordToken === SyntaxKind.NewKeyword && node.name.text === 'target' && !newTarget) {
        report("'new.target' is only valid inside functions, class field initializers, or static blocks");
      }
      if (isMetaProperty(node) && node.keywordToken === SyntaxKind.ImportKeyword) {
        if (!module && node.name.text === 'meta') report("'import.meta' is only valid in module code");
        if (!['meta','source','defer'].includes(node.name.text)) {
          report("The only valid meta properties for 'import' are 'import.meta', 'import.source()', or 'import.defer()'");
        }
      }
      if (isForInOrOfStatement(node)) {
        if (isVariableDeclarationList(node.initializer)) {
          const { declarations } = node.initializer;
          if (declarations.length !== 1) {
            report('Only a single variable declaration is allowed in a for-in/of statement', node.initializer);
          }
          for (const declaration of declarations) {
            if (declaration.initializer) {
              report(`for-${isForInStatement(node) ? 'in' : 'of'} loop variable declaration may not have an initializer`, declaration);
            }
          }
        } else {
          checkTarget(node.initializer, true, strict);
        }
      }
      if (isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const read = expression => isBinaryExpression(expression) ? expression.operatorToken.kind : undefined;
        const nullish = SyntaxKind.QuestionQuestionToken;
        if (op === SyntaxKind.LessThanLessThanToken && isAsExpression(node.left)) {
          let type = node.left.type;
          while (isTypeOperatorNode(type)) type = type.type;
          if (isImportTypeNode(type) && !type.typeArguments) {
            report("Expected '>' to close a type parameter list, but found ';'");
          }
        }
        if (op === nullish && [node.left,node.right].some(side => logical.has(read(side))) ||
            logical.has(op) && [node.left,node.right].some(side => read(side) === nullish)) {
          report('Logical expressions and nullish coalescing cannot be mixed');
        }
        if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment) {
          checkTarget(node.left, op === SyntaxKind.EqualsToken, strict);
        }
      }
      if ((isPostfixUnaryExpression(node) || isPrefixUnaryExpression(node)) && isUpdateKind(node.operator)) {
        const operand = peelTarget(node.operand);
        if (!isAssignmentTarget(operand) || isOptionalChain(operand)) report('Invalid operand for increment/decrement operator');
        else if (strict && isIdentifier(operand) && strictRestrictedBindings.has(operand.text)) {
          report("Cannot assign to 'eval' or 'arguments' in strict mode");
        }
      }
      if (strict && isDeleteExpression(node)) {
        let value = node.expression;
        while (isParenthesizedExpression(value)) value = value.expression;
        if (isIdentifier(value)) report('Deleting a variable in strict mode is not allowed');
      }
      if (!module && strict && isNumericLiteral(node)) {
        const raw = node.getText(file);
        if (/^0[0-7]+$/.test(raw)) report('Octal literals are not allowed in strict mode');
        else if (/^0[0-9]+$/.test(raw)) report('Decimals with leading zeros are not allowed in strict mode');
      }
      if (!module && strict && isStringLiteral(node)) {
        for (const [, legacy] of node.getText(file).matchAll(/\\(?:(0[0-9]|[1-9])|[\s\S])/g)) {
          if (legacy) {
            report('Legacy decimal and octal escape sequences are not allowed in strict mode');
            break;
          }
        }
      }
      if (isVariableDeclarationList(node) && node.declarations.hasTrailingComma) {
        report(`Unexpected token '${tokenAt(node.getEnd())}' in binding pattern`);
      }
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
        if (!node.arguments.length) report("Unexpected token ')'");
        else if (isSpreadElement(node.arguments[0])) report("Unexpected token '...'");
        else if (node.arguments.length > 2) report(`Expected ')' after import(), but found '${tokenAt(node.arguments[2].getStart(file))}'`);
      }
      if (isArrowFunction(node) && forInitializer && isBinaryExpression(node.body) &&
          node.body.operatorToken.kind === SyntaxKind.InKeyword) {
        report("Expected ',' or ')' in parenthesized expression, but found 'in'");
      }
      if (isTaggedTemplateExpression(node) && (node.questionDotToken || isOptionalChain(node.tag))) {
        report('Tagged template expressions are not permitted in an optional chain');
      }
      if (isObjectLiteralExpression(node) && !assignmentPattern) {
        const prototypes = node.properties.filter(p => isPropertyAssignment(p) &&
          (isStringLiteral(p.name) || isIdentifier(p.name)) && p.name.text === '__proto__');
        if (prototypes.length > 1) report("Duplicate '__proto__' property in object literal");
      }
      if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) {
        const rest = node.elements.findIndex(element => isBindingElement(element) && element.dotDotDotToken);
        if (rest >= 0 && rest !== node.elements.length - 1 && isObjectBindingPattern(node)) {
          report('Rest element must be the last property');
        }
        if (rest >= 0 && node.elements.hasTrailingComma && isArrayBindingPattern(node)) {
          report('Rest element cannot have a trailing comma in array destructuring.');
        }
        if (rest >= 0 && rest !== node.elements.length - 1 && isArrayBindingPattern(node)) {
          report('Rest element must be the last element', node.elements[rest]);
        }
      }
      if (parent && isObjectLiteralExpression(parent) && node.name && isPrivateIdentifier(node.name)) {
        report(`Expected ',' or '}' in object, but found '${node.name.text}'`, node.name);
      }
      if (isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer && !assignmentPattern) {
        report('Shorthand property cannot have a default value in object expression');
      }
      if (isVariableDeclarationList(node) && (node.flags & NodeFlags.Const) !== 0 && !node.declarations.length) {
        report(`Unexpected token '${tokenAt(node.getEnd())}' in binding pattern`);
      }
      if (isFunctionLike(node) && node.body && ambient && isFunctionDeclaration(node)) {
        report('An implementation cannot be declared in ambient contexts');
      }
      if (isFunctionLike(node) && node.body && isBlock(node.body) &&
          node.parameters.some(nonSimpleParameter)) {
        for (const statement of node.body.statements) {
          if (!isExpressionStatement(statement) || !isStringLiteral(statement.expression)) break;
          if (['"use strict"', "'use strict'"].includes(statement.expression.getText(file))) {
            report("Illegal 'use strict' directive in function with non-simple parameter list", statement.expression);
            break;
          }
        }
      }
      if (isStatement(node)) {
        scanner.setTextPos(node.getStart(file));
        const first = scanner.scan();
        const second = scanner.scan();
        const third = scanner.scan();
        if (first === SyntaxKind.DeclareKeyword && second === SyntaxKind.ExportKeyword) {
          report("Expected a semicolon or an implicit semicolon after a statement, but found 'export'");
        }
        if (first === SyntaxKind.ExportKeyword && second === SyntaxKind.DeclareKeyword && third === SyntaxKind.ExportKeyword) {
          report("Expected declaration after 'export', but found 'declare'");
        }
        if (first === SyntaxKind.ExportKeyword && second === SyntaxKind.ExportKeyword) {
          report("Expected declaration after 'export', but found 'export'");
        }
      }
      forEachChild(node, child => {
        const inField = isClassStaticBlockDeclaration(node) || (isPropertyDeclaration(node) && node.initializer === child);
        const fn = isFunctionLike(node);
        const arrow = isArrowFunction(node);
        const nextField = inField || (field && (!fn || arrow || node.name === child));
        const nextAwait = inField ? false : fn && node.name !== child ? hasModifier(node, SyntaxKind.AsyncKeyword) : canAwait;
        const nextYield = inField ? false : fn && node.name !== child ? !!node.asteriskToken : canYield;
        const nextFormal = fn ? node.parameters.includes(child) : formal;
        const parentPattern = assignmentPattern && (isArrayLiteralExpression(node) || isObjectLiteralExpression(node) ||
          isParenthesizedExpression(node) || isPropertyAssignment(node) && node.initializer === child ||
          isSpreadAssignment(node) || isSpreadElement(node));
        const nextPattern = parentPattern || (isPlainAssignment(node) && node.left === child) ||
          (isForInOrOfStatement(node) && node.initializer === child);
        pending.push({node: child, parent: node, canAwait: nextAwait, field: nextField, formal: nextFormal,
          canYield: nextYield, ambient, assignmentPattern: nextPattern, strict,
          newTarget: inField || newTarget || fn && !arrow && node.name !== child,
          forInitializer: forInitializer || isForStatement(node) && node.initializer === child});
      });
    }
  }

  function hasStrictDirective(statements, file) {
    for (const statement of statements) {
      if (!isExpressionStatement(statement) || !isStringLiteral(statement.expression)) return false;
      const text = statement.expression.getText(file);
      if (text === '"use strict"' || text === "'use strict'") return true;
    }
    return false;
  }

  function strictScope(node, file, inherited) {
    return inherited || isClassLike(node) ||
      (isFunctionLike(node) && node.body && isBlock(node.body) && hasStrictDirective(node.body.statements, file));
  }

  function nonSimpleParameter(parameter) {
    return parameter.dotDotDotToken || parameter.initializer || !isIdentifier(parameter.name);
  }

  return function checkGrammar(file, mode, emit) {
    const module = mode !== 'script';
    const strict = module || hasStrictDirective(file.statements, file);
    checkExpressionSyntax(file, module, strict, emit);
    checkTypeSyntax(file, module, emit);
    checkContexts(file, strict, emit);
    checkStatementSyntax(file, module, strict, emit);
    checkPrivateNames(file, emit);
    const nestedVars = file.statements.filter(statement => !isVariableStatement(statement)).flatMap(bindings.nestedVarsIn);
    bindings.checkScope(file.statements, emit, { nestedVars });
    bindings.checkNamespaceExports(file, emit);
    if (module) bindings.checkExports(file, emit, nestedVars);
  };
}
