// First-level regular expression mutations: anchors, class negation, quantifier removal and lookaround negation.
// Every result is compiled once, because an invalid literal would stop the whole module from loading.
const predefined = new Map([['d', 'D'], ['D', 'd'], ['s', 'S'], ['S', 's'], ['w', 'W'], ['W', 'w']]);

function quantifierEnd(pattern, at) {
  const unit = pattern[at];
  let end;
  if (unit === '?' || unit === '*' || unit === '+') end = at + 1;
  else if (unit === '{') {
    const match = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(at));
    if (!match) return -1;
    end = at + match[0].length;
  } else return -1;
  return pattern[end] === '?' ? end + 1 : end;
}

export function mutatePattern(pattern, flags = '') {
  if (!pattern.length) return [];
  const compiles = source => {
    try {
      new RegExp(source, flags);
      return true;
    } catch {
      return false;
    }
  };
  if (!compiles(pattern)) return [];
  const unicode = /[uv]/.test(flags);
  const edits = [];
  const replace = (start, end, text) => edits.push(pattern.slice(0, start) + text + pattern.slice(end));
  let inClass = false;
  let quantifiable = false;
  for (let at = 0; at < pattern.length; at++) {
    const unit = pattern[at];
    if (unit === '\\') {
      const next = pattern[at + 1];
      if (predefined.has(next)) replace(at + 1, at + 2, predefined.get(next));
      else if (unicode && (next === 'p' || next === 'P') && pattern[at + 2] === '{') replace(at + 1, at + 2, next === 'p' ? 'P' : 'p');
      if (unicode && (next === 'p' || next === 'P' || next === 'u') && pattern[at + 2] === '{') at = pattern.indexOf('}', at);
      else if (next === 'k' && pattern[at + 2] === '<') at = pattern.indexOf('>', at);
      else if (next === 'c') at += 2;
      else if (next === 'x') at += 3;
      else if (next === 'u') at += 5;
      else at++;
      quantifiable = !inClass;
      continue;
    }
    if (inClass) {
      if (unit === ']') {
        inClass = false;
        quantifiable = true;
      }
      continue;
    }
    if (unit === '[') {
      if (pattern[at + 1] === '^') replace(at + 1, at + 2, '');
      else replace(at + 1, at + 1, '^');
      inClass = true;
      // In JavaScript `[]` and `[^]` are complete classes: a closing bracket is never a literal first member.
      if (pattern[at + 1] === '^') at++;
      continue;
    }
    if (unit === '^') {
      replace(at, at + 1, '');
      quantifiable = false;
      continue;
    }
    if (unit === '$') {
      replace(at, at + 1, '');
      quantifiable = false;
      continue;
    }
    if (unit === '(') {
      const look = /^\(\?(<?)([=!])/.exec(pattern.slice(at));
      if (look) {
        const sign = at + 2 + look[1].length;
        replace(sign, sign + 1, look[2] === '=' ? '!' : '=');
        at = sign;
      } else if (pattern[at + 1] === '?') {
        const named = /^\(\?<[^>]+>/.exec(pattern.slice(at));
        at += named ? named[0].length - 1 : 2;
      }
      quantifiable = false;
      continue;
    }
    if (unit === '|') {
      quantifiable = false;
      continue;
    }
    if (quantifiable) {
      const end = quantifierEnd(pattern, at);
      if (end > 0) {
        replace(at, end, '');
        at = end - 1;
        quantifiable = false;
        continue;
      }
    }
    quantifiable = true;
  }
  return [...new Set(edits)].filter(source => source !== pattern && compiles(source));
}
