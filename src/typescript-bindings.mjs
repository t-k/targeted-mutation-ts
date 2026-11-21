const conflicts = {
  Lexical: ['Lexical', 'Var', 'Function', 'Class', 'Enum', 'ConstEnum', 'Namespace', 'AmbientClass'],
  Var: ['Lexical', 'Function', 'Class', 'Enum', 'ConstEnum', 'Namespace', 'AmbientClass'],
  Function: ['Lexical', 'Var', 'Class', 'Enum', 'ConstEnum'],
  Class: ['Lexical', 'Var', 'Function', 'Class', 'Type', 'Enum', 'ConstEnum', 'AmbientClass'],
  Type: ['Class', 'Type', 'Interface', 'Enum', 'ConstEnum', 'AmbientClass'],
  Interface: ['Type', 'Enum', 'ConstEnum'],
  Enum: ['Lexical', 'Var', 'Function', 'Class', 'Type', 'Interface', 'ConstEnum', 'AmbientClass'],
  ConstEnum: ['Lexical', 'Var', 'Function', 'Class', 'Type', 'Interface', 'Enum', 'Namespace', 'AmbientClass'],
  Namespace: ['Lexical', 'Var', 'ConstEnum'],
  Import: ['Import'],
  AmbientClass: ['Lexical', 'Var', 'Class', 'Type', 'Enum', 'ConstEnum', 'AmbientClass'],
};

export function createTypeScriptBindings(ts) {
  const {
    ModifierFlags, NodeFlags, SyntaxKind, forEachChild, getCombinedModifierFlags, isArrayBindingPattern,
    isBindingElement, isCaseBlock, isCaseOrDefaultClause, isCatchClause, isClassDeclaration, isClassLike,
    isEmptyStatement, isEnumDeclaration, isExportAssignment, isExportDeclaration, isFunctionDeclaration,
    isFunctionLike, isIdentifier, isImportDeclaration, isImportEqualsDeclaration, isInterfaceDeclaration,
    isModuleBlock, isModuleDeclaration, isNamedExports, isNamedImports, isNamespaceExport, isNamespaceImport,
    isObjectBindingPattern, isStatement, isTypeAliasDeclaration, isVariableDeclarationList, isVariableStatement,
  } = ts;
  const hasModifier = (node, flags) => (getCombinedModifierFlags(node) & flags) !== 0;

  function namesIn(pattern) {
    const pending = [pattern];
    const names = [];
    while (pending.length) {
      const node = pending.pop();
      if (isIdentifier(node)) {
        names.push(node);
      } else if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) {
        for (let index = node.elements.length - 1; index >= 0; index--) {
          const element = node.elements[index];
          if (isBindingElement(element)) pending.push(element.name);
        }
      }
    }
    return names;
  }

  function hasRuntimeMembers(namespace) {
    const pending = [namespace];
    while (pending.length) {
      const node = pending.pop();
      if (isModuleDeclaration(node)) {
        if (node.body) pending.push(node.body);
      } else if (isModuleBlock(node)) {
        for (const statement of node.statements) pending.push(statement);
      } else if (!isTypeAliasDeclaration(node) && !isInterfaceDeclaration(node) && !isEmptyStatement(node)) {
        return true;
      }
    }
    return false;
  }

  function declaration(statement, ambient = false) {
    if (isVariableStatement(statement)) {
      const { declarationList } = statement;
      const kind = (declarationList.flags & NodeFlags.BlockScoped) === 0 ? 'Var' : 'Lexical';
      return { kind, names: declarationList.declarations.flatMap(node => namesIn(node.name)) };
    }
    if (isFunctionDeclaration(statement)) return { kind: 'Function', names: statement.name ? [statement.name] : [] };
    if (isClassDeclaration(statement)) {
      const kind = ambient || hasModifier(statement, ModifierFlags.Ambient) ? 'AmbientClass' : 'Class';
      return { kind, names: statement.name ? [statement.name] : [] };
    }
    if (isTypeAliasDeclaration(statement)) return { kind: 'Type', names: [statement.name] };
    if (isInterfaceDeclaration(statement)) return { kind: 'Interface', names: [statement.name] };
    if (isEnumDeclaration(statement)) {
      const kind = hasModifier(statement, ModifierFlags.Const) ? 'ConstEnum' : 'Enum';
      return { kind, names: [statement.name] };
    }
    if (isModuleDeclaration(statement) && isIdentifier(statement.name) &&
        (statement.flags & NodeFlags.GlobalAugmentation) === 0 && hasRuntimeMembers(statement)) {
      return { kind: 'Namespace', names: [statement.name] };
    }
    if (isImportDeclaration(statement) && statement.importClause) {
      const { name, namedBindings } = statement.importClause;
      const names = name ? [name] : [];
      if (namedBindings && isNamespaceImport(namedBindings)) names.push(namedBindings.name);
      if (namedBindings && isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) names.push(element.name);
      }
      return { kind: 'Import', names };
    }
    if (isImportEqualsDeclaration(statement)) return { kind: 'Import', names: [statement.name] };
  }

  function duplicate(name, previous, report) {
    report(name, `Identifier '${name.text}' has already been declared`, previous);
  }

  function nestedVarsIn(statement) {
    const pending = [statement];
    const names = [];
    while (pending.length) {
      const node = pending.pop();
      if (isFunctionLike(node) || isClassLike(node) || isModuleDeclaration(node)) continue;
      if (isVariableDeclarationList(node)) {
        if ((node.flags & NodeFlags.BlockScoped) === 0) {
          for (const declaration of node.declarations) names.push(...namesIn(declaration.name));
        }
        continue;
      }
      forEachChild(node, child => {
        if (isStatement(child) || isVariableDeclarationList(child) ||
            isCaseBlock(child) || isCaseOrDefaultClause(child) || isCatchClause(child)) {
          pending.push(child);
        }
      });
    }
    return names;
  }

  function checkScope(statements, report, { parameters = [], catchPattern = false, nestedVars = [], ambient = false } = {}) {
    const seen = new Map();
    for (const name of parameters) {
      const previous = seen.get(name.text);
      if (previous) duplicate(name, previous.values().next().value, report);
      seen.set(name.text, new Map([[catchPattern ? 'PatternParameter' : 'Parameter', name]]));
    }
    const entries = statements.map(statement => declaration(statement, ambient));
    if (nestedVars.length) entries.push({ kind: 'Var', names: nestedVars });
    for (const entry of entries) {
      if (!entry) continue;
      for (const name of entry.names) {
        const already = seen.get(name.text) ?? new Map();
        const collision = conflicts[entry.kind].find(kind => already.has(kind));
        const hasValue = entry.kind !== 'Type' && entry.kind !== 'Interface';
        const parameter = hasValue && (already.get('PatternParameter') ||
          (entry.kind === 'Var' ? undefined : already.get('Parameter')));
        const earlier = already.get(collision) ?? parameter;
        if (earlier) duplicate(name, earlier, report);
        if (!already.has(entry.kind)) already.set(entry.kind, name);
        seen.set(name.text, already);
      }
    }
  }

  function checkExports(file, report, nestedVars) {
    const locals = new Set(nestedVars.map(name => name.text));
    for (const statement of file.statements) {
      for (const name of declaration(statement)?.names ?? []) locals.add(name.text);
      if (isModuleDeclaration(statement) && isIdentifier(statement.name)) locals.add(statement.name.text);
    }

    const exported = new Map();
    let implicitDefault;
    function record(name, node) {
      if (exported.has(name)) report(node, `Duplicate export of '${name}'`, exported.get(name));
      else exported.set(name, node);
    }
    for (const statement of file.statements) {
      if (isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        if (!clause) continue;
        if (isNamespaceExport(clause)) {
          record(clause.name.text, clause.name);
        } else if (isNamedExports(clause)) {
          for (const element of clause.elements) {
            const local = element.propertyName ?? element.name;
            if (!statement.moduleSpecifier && !statement.isTypeOnly && !element.isTypeOnly && !locals.has(local.text)) {
              report(local, `Export '${local.text}' is not defined`);
            }
            record(element.name.text, element.name);
          }
        }
        continue;
      }
      if (isExportAssignment(statement)) {
        if (!statement.isExportEquals) {
          if (implicitDefault) report(statement, "Duplicate export of 'default'", implicitDefault);
          record('default', statement);
        }
        continue;
      }
      if (!hasModifier(statement, ModifierFlags.Export)) continue;
      const defaultToken = statement.modifiers?.find(modifier => modifier.kind === SyntaxKind.DefaultKeyword);
      if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement) ||
          (isFunctionDeclaration(statement) && !statement.body)) {
        implicitDefault ??= defaultToken;
        continue;
      }
      if (defaultToken) {
        record('default', defaultToken);
        continue;
      }
      if (isVariableStatement(statement) || isClassDeclaration(statement) ||
          isFunctionDeclaration(statement) || isImportEqualsDeclaration(statement)) {
        for (const name of declaration(statement)?.names ?? []) record(name.text, name);
      }
    }
  }

  function checkNamespaceExports(file, report) {
    const pending = [{ statements: file.statements, namespaces: new Map(), ambient: false, shared: false }];
    while (pending.length) {
      const { statements, namespaces, ambient, shared } = pending.pop();
      for (const statement of statements) {
        if (!isModuleDeclaration(statement)) continue;
        const ambientNamespace = ambient || hasModifier(statement, ModifierFlags.Ambient);
        const joinsNamespace = !shared || ambient || hasModifier(statement, ModifierFlags.Export);
        let scope = namespaces;
        let part = statement;
        while (part && isModuleDeclaration(part) && part.body) {
          const key = JSON.stringify([part.name.kind, part.name.text]);
          const previous = joinsNamespace ? scope.get(key) : undefined;
          const joined = previous ?? { namespaces: new Map(), exports: new Map() };
          if (joinsNamespace && !previous) scope.set(key, joined);
          if (isModuleBlock(part.body)) {
            const children = part.body.statements;
            const current = new Map();
            for (const child of children) {
              if (!ambientNamespace && !hasModifier(child, ModifierFlags.Export)) continue;
              const entry = declaration(child, ambientNamespace);
              if (!entry) continue;
              for (const name of entry.names) {
                const already = joined.exports.get(name.text);
                const collision = already && conflicts[entry.kind].find(kind => already.has(kind));
                if (collision) duplicate(name, already.get(collision), report);
                const kinds = current.get(name.text) ?? new Map();
                if (!kinds.has(entry.kind)) kinds.set(entry.kind, name);
                current.set(name.text, kinds);
              }
            }
            for (const [name, kinds] of current) {
              const merged = joined.exports.get(name) ?? new Map();
              for (const [kind, token] of kinds) if (!merged.has(kind)) merged.set(kind, token);
              joined.exports.set(name, merged);
            }
            pending.push({ statements: children, namespaces: joined.namespaces, ambient: ambientNamespace, shared: true });
          }
          scope = joined.namespaces;
          part = part.body;
        }
      }
    }
  }

  return { namesIn, nestedVarsIn, checkScope, checkExports, checkNamespaceExports };
}
