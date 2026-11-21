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
  const hasModifier = (node, flags) => (ts.getCombinedModifierFlags(node) & flags) !== 0;

  function namesIn(pattern) {
    const pending = [pattern];
    const names = [];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isIdentifier(node)) {
        names.push(node);
      } else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        for (let index = node.elements.length - 1; index >= 0; index--) {
          const element = node.elements[index];
          if (ts.isBindingElement(element)) pending.push(element.name);
        }
      }
    }
    return names;
  }

  function hasRuntimeMembers(namespace) {
    const pending = [namespace];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isModuleDeclaration(node)) {
        if (node.body) pending.push(node.body);
      } else if (ts.isModuleBlock(node)) {
        for (const statement of node.statements) pending.push(statement);
      } else if (!ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isEmptyStatement(node)) {
        return true;
      }
    }
    return false;
  }

  function declaration(statement, ambient = false) {
    if (ts.isVariableStatement(statement)) {
      const { declarationList } = statement;
      const kind = (declarationList.flags & ts.NodeFlags.BlockScoped) === 0 ? 'Var' : 'Lexical';
      return { kind, names: declarationList.declarations.flatMap(node => namesIn(node.name)) };
    }
    if (ts.isFunctionDeclaration(statement)) return { kind: 'Function', names: statement.name ? [statement.name] : [] };
    if (ts.isClassDeclaration(statement)) {
      const kind = ambient || hasModifier(statement, ts.ModifierFlags.Ambient) ? 'AmbientClass' : 'Class';
      return { kind, names: statement.name ? [statement.name] : [] };
    }
    if (ts.isTypeAliasDeclaration(statement)) return { kind: 'Type', names: [statement.name] };
    if (ts.isInterfaceDeclaration(statement)) return { kind: 'Interface', names: [statement.name] };
    if (ts.isEnumDeclaration(statement)) {
      const kind = hasModifier(statement, ts.ModifierFlags.Const) ? 'ConstEnum' : 'Enum';
      return { kind, names: [statement.name] };
    }
    if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) &&
        (statement.flags & ts.NodeFlags.GlobalAugmentation) === 0 && hasRuntimeMembers(statement)) {
      return { kind: 'Namespace', names: [statement.name] };
    }
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const { name, namedBindings } = statement.importClause;
      const names = name ? [name] : [];
      if (namedBindings && ts.isNamespaceImport(namedBindings)) names.push(namedBindings.name);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) names.push(element.name);
      }
      return { kind: 'Import', names };
    }
    if (ts.isImportEqualsDeclaration(statement)) return { kind: 'Import', names: [statement.name] };
  }

  function duplicate(name, previous, report) {
    report(name, `Identifier '${name.text}' has already been declared`, previous);
  }

  function nestedVarsIn(statement) {
    const pending = [statement];
    const names = [];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node)) continue;
      if (ts.isVariableDeclarationList(node)) {
        if ((node.flags & ts.NodeFlags.BlockScoped) === 0) {
          for (const declaration of node.declarations) names.push(...namesIn(declaration.name));
        }
        continue;
      }
      ts.forEachChild(node, child => {
        if (ts.isStatement(child) || ts.isVariableDeclarationList(child) ||
            ts.isCaseBlock(child) || ts.isCaseOrDefaultClause(child) || ts.isCatchClause(child)) {
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
      if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) locals.add(statement.name.text);
    }

    const exported = new Map();
    let implicitDefault;
    function record(name, node) {
      if (exported.has(name)) report(node, `Duplicate export of '${name}'`, exported.get(name));
      else exported.set(name, node);
    }
    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        if (!clause) continue;
        if (ts.isNamespaceExport(clause)) {
          record(clause.name.text, clause.name);
        } else if (ts.isNamedExports(clause)) {
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
      if (ts.isExportAssignment(statement)) {
        if (!statement.isExportEquals) {
          if (implicitDefault) report(statement, "Duplicate export of 'default'", implicitDefault);
          record('default', statement);
        }
        continue;
      }
      if (!hasModifier(statement, ts.ModifierFlags.Export)) continue;
      const defaultToken = statement.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
          (ts.isFunctionDeclaration(statement) && !statement.body)) {
        implicitDefault ??= defaultToken;
        continue;
      }
      if (defaultToken) {
        record('default', defaultToken);
        continue;
      }
      if (ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
        for (const name of declaration(statement)?.names ?? []) record(name.text, name);
      }
    }
  }

  function checkNamespaceExports(file, report) {
    const pending = [{ statements: file.statements, namespaces: new Map(), ambient: false, shared: false }];
    while (pending.length) {
      const { statements, namespaces, ambient, shared } = pending.pop();
      for (const statement of statements) {
        if (!ts.isModuleDeclaration(statement)) continue;
        const ambientNamespace = ambient || hasModifier(statement, ts.ModifierFlags.Ambient);
        const joinsNamespace = !shared || ambient || hasModifier(statement, ts.ModifierFlags.Export);
        let scope = namespaces;
        let part = statement;
        while (part && ts.isModuleDeclaration(part) && part.body) {
          const key = JSON.stringify([part.name.kind, part.name.text]);
          const previous = joinsNamespace ? scope.get(key) : undefined;
          const joined = previous ?? { namespaces: new Map(), exports: new Map() };
          if (joinsNamespace && !previous) scope.set(key, joined);
          if (ts.isModuleBlock(part.body)) {
            const children = part.body.statements;
            const current = new Map();
            for (const child of children) {
              if (!ambientNamespace && !hasModifier(child, ts.ModifierFlags.Export)) continue;
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
