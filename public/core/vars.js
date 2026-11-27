// Variable expansion: $VAR, ${VAR}, ${VAR:-default}, ${VAR:+alternate}, \$

export function expand(input, scope, missing) {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && input[i + 1] === '$') { out += '$'; i++; continue; }
    if (c !== '$') { out += c; continue; }

    if (input[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < input.length && depth > 0; j++) {
        if (input[j] === '{') depth++;
        else if (input[j] === '}') depth--;
      }
      const m = depth === 0 && input.slice(i + 2, j - 1).match(/^([A-Za-z_]\w*)(?:(:?[-+?])([\s\S]*))?/);
      if (!m) { out += c; continue; }
      const [, name, op, word = ''] = m;
      const colon = op?.startsWith(':');
      const present = scope.has(name) && scope.get(name) !== null && (!colon || scope.get(name) !== '');
      if (op?.endsWith('-')) out += present ? scope.get(name) : expand(word, scope, missing);
      else if (op?.endsWith('+')) out += present ? expand(word, scope, missing) : '';
      else if (present) out += scope.get(name);
      else if (scope.get(name) !== '') { missing?.add(name); out += input.slice(i, j); }
      i = j - 1;
      continue;
    }

    const m = input.slice(i + 1).match(/^[A-Za-z_]\w*/);
    if (!m) { out += c; continue; }
    const name = m[0];
    if (scope.has(name) && scope.get(name) !== null) out += scope.get(name);
    else { missing?.add(name); out += `$${name}`; }
    i += name.length;
  }
  return out;
}
