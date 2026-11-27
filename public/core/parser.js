// Dockerfile / Containerfile parser. Line numbers start at 1.

export const INSTRUCTIONS = [
  'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY',
  'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL',
  'HEALTHCHECK', 'SHELL',
];

const HEREDOC_KEYWORDS = new Set(['RUN', 'COPY', 'ADD']);

export function parse(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const instructions = [];
  const comments = [];
  const directives = {};
  const issues = [];
  let escape = '\\';
  let i = 0;

  // Parser directives are only valid at the very top of the file.
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^#\s*([a-zA-Z]+)\s*=\s*(\S+)\s*$/);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (!['syntax', 'escape', 'check'].includes(key)) break;
    directives[key] = m[2];
    comments.push({ line: i + 1, text: lines[i] });
    if (key === 'escape') {
      if (m[2] === '\\' || m[2] === '`') escape = m[2];
      else issues.push({ line: i + 1, key: 'parse.escape', params: { value: m[2] } });
    }
  }

  const continues = (s) => {
    const t = s.replace(/[ \t]+$/, '');
    let n = 0;
    while (n < t.length && t[t.length - 1 - n] === escape) n++;
    return n % 2 === 1;
  };
  const stripContinuation = (s) => s.replace(/[ \t]+$/, '').slice(0, -1);

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '') { i++; continue; }
    if (trimmed.startsWith('#')) {
      comments.push({ line: i + 1, text: lines[i] });
      i++;
      continue;
    }

    const startLine = i + 1;
    let logical = '';
    let open = false;
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();
      if (open && t.startsWith('#')) { comments.push({ line: i + 1, text: line }); i++; continue; }
      if (open && t === '') {
        issues.push({ line: i + 1, severity: 'warning', key: 'parse.emptyContinuation' });
        i++;
        continue;
      }
      i++;
      if (continues(line)) {
        logical += stripContinuation(line);
        open = true;
      } else {
        logical += line;
        open = false;
        break;
      }
    }
    if (open) issues.push({ line: i, key: 'parse.eofContinuation' });

    const m = logical.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!m) continue;
    const rawKeyword = m[1];
    const keyword = rawKeyword.toUpperCase();
    const args = (m[2] || '').trim();
    const heredocs = [];

    if (HEREDOC_KEYWORDS.has(keyword)) {
      const re = /(?:^|\s)<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2(?=\s|$|[>|;&])/g;
      let h;
      while ((h = re.exec(args))) heredocs.push({ name: h[3], stripTabs: h[1] === '-', lines: [] });
      for (const doc of heredocs) {
        let closed = false;
        while (i < lines.length) {
          const body = doc.stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
          i++;
          if (body === doc.name) { closed = true; break; }
          doc.lines.push(body);
        }
        if (!closed) issues.push({ line: startLine, key: 'parse.heredoc', params: { name: doc.name } });
      }
    }

    instructions.push({
      keyword, rawKeyword, args, startLine,
      endLine: Math.min(i, lines.length),
      heredocs,
    });
  }

  return { instructions, comments, directives, issues, escape, lines };
}

// Splits into global ARGs (before FROM) and stages.
export function splitStages(parsed) {
  const globals = [];
  const stages = [];
  for (const ins of parsed.instructions) {
    if (ins.keyword === 'FROM') {
      stages.push({ index: stages.length, from: ins, ...parseFrom(ins.args), instructions: [] });
    } else if (stages.length === 0) {
      globals.push(ins);
    } else {
      stages[stages.length - 1].instructions.push(ins);
    }
  }
  // A stage spans from the comments right above its FROM to the next stage.
  const commentLines = new Set(parsed.comments.map((c) => c.line));
  for (const stage of stages) {
    let start = stage.from.startLine;
    const prevEnd = stage.index === 0
      ? (globals.at(-1)?.endLine ?? 0)
      : (stages[stage.index - 1].instructions.at(-1) ?? stages[stage.index - 1].from).endLine;
    while (start - 1 > prevEnd && commentLines.has(start - 1)
      && !/^#\s*(syntax|escape|check)\s*=/i.test(parsed.lines[start - 2])) start--;
    stage.startLine = start;
  }
  for (const stage of stages) {
    const next = stages[stage.index + 1];
    stage.endLine = next ? next.startLine - 1 : parsed.lines.length;
  }
  return { globals, stages };
}

export function parseFrom(args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  const flags = [];
  while (tokens[0]?.startsWith('--')) flags.push(tokens.shift());
  const platform = flags.find((f) => f.startsWith('--platform='))?.slice('--platform='.length) ?? null;
  const image = tokens[0] ?? '';
  let name = null;
  let malformed = false;
  if (tokens.length > 1) {
    if (tokens.length === 3 && tokens[1].toUpperCase() === 'AS') name = tokens[2];
    else malformed = true;
  }
  return { image, name, platform, flags, malformed };
}

// Splits on whitespace, honouring quotes and escapes. raw is the source token, value is unquoted.
export function tokenize(args, escape = '\\') {
  const tokens = [];
  let raw = '';
  let value = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === escape && quote !== "'" && i + 1 < args.length) {
      const next = args[i + 1];
      raw += c + next;
      // Keep escaped $ for the variable expansion step.
      if (next === '$') value += '\\$';
      else if (quote === '"' && next !== '"' && next !== escape) value += c + next;
      else value += next;
      started = true;
      i++;
      continue;
    }
    if (quote) {
      raw += c;
      if (c === quote) quote = null;
      else value += (quote === "'" && c === '$') ? '\\$' : c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; raw += c; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) tokens.push({ raw, value });
      raw = ''; value = ''; started = false;
      continue;
    }
    raw += c; value += c; started = true;
  }
  if (started) tokens.push({ raw, value });
  return { tokens, unterminated: quote !== null };
}

// key=value list of ENV / LABEL / ARG.
export function parsePairs(ins, escape = '\\') {
  const { tokens, unterminated } = tokenize(ins.args, escape);
  if (tokens.length === 0) return { pairs: [], legacy: false, unterminated };
  if (ins.keyword !== 'ARG' && !tokens[0].raw.includes('=')) {
    const key = tokens[0].raw;
    const rest = ins.args.slice(ins.args.indexOf(key) + key.length).trim();
    return {
      pairs: [{ key, value: rest === '' ? null : rest }],
      legacy: true,
      unterminated,
    };
  }
  const pairs = tokens.map((t) => {
    const eq = t.raw.indexOf('=');
    if (eq < 0) return { key: t.value, value: null };
    return { key: tokenize(t.raw.slice(0, eq), escape).tokens[0]?.value ?? '', value: tokenize(t.raw.slice(eq + 1), escape).tokens[0]?.value ?? '' };
  });
  return { pairs, legacy: false, unterminated };
}

// Strips leading --flags.
export function splitFlags(args) {
  const flags = [];
  let rest = args.trim();
  let m;
  while ((m = rest.match(/^(--[a-zA-Z][\w-]*)(?:=("[^"]*"|'[^']*'|\S*))?(?:\s+|$)/))) {
    flags.push({ name: m[1].slice(2), value: m[2] === undefined ? null : m[2].replace(/^["']|["']$/g, '') });
    rest = rest.slice(m[0].length);
  }
  return { flags, rest };
}

// Detects the exec (JSON array) form.
export function parseExecForm(args) {
  const t = args.trim();
  if (!t.startsWith('[')) return { form: 'shell', value: t };
  try {
    const value = JSON.parse(t);
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return { form: 'exec', value };
    return { form: 'invalid', value: t, reason: 'diag.jsonStrings' };
  } catch {
    // Shell tests such as `[ -f x ] && ...` are a valid shell form.
    if (/^\[\s*["']/.test(t) || /^\[\s*\]$/.test(t)) {
      return { form: 'invalid', value: t, reason: 'diag.jsonSyntax' };
    }
    return { form: 'shell', value: t };
  }
}
