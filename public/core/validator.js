// Syntax and best-practice checks. severity: error (build fails) / warning (risk) / info (suggestion)

import { INSTRUCTIONS, parsePairs, splitFlags, parseExecForm, tokenize } from './parser.js';
import { parseImageRef } from './imageref.js';
import { simulate, findStage, AUTOMATIC_ARGS } from './simulator.js';
import { translator } from './i18n.js';

const FLAGS = {
  FROM: ['platform'],
  COPY: ['from', 'chown', 'chmod', 'link', 'parents', 'exclude'],
  ADD: ['chown', 'chmod', 'link', 'checksum', 'keep-git-dir', 'exclude', 'unpack'],
  RUN: ['mount', 'network', 'security', 'device'],
  HEALTHCHECK: ['interval', 'timeout', 'start-period', 'start-interval', 'retries'],
};

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)/i;
const ID = /^(?:\d+|[a-zA-Z_][a-zA-Z0-9_.-]*\$?)$/;
const VAR_ONLY = /^\$(?:\{[^}]+\}|[A-Za-z_]\w*)$/;
const SIGNALS = /^(?:\d+|(?:SIG)?(?:HUP|INT|QUIT|KILL|TERM|USR1|USR2|WINCH|STOP|CONT|ABRT|ALRM|PIPE)|SIGRTMIN\+\d+|SIGRTMAX-\d+)$/;

/** Returns null when valid, otherwise a message {key, params}. */
export function checkUserSpec(spec) {
  const problem = (key, value) => ({ key, params: { value } });
  if (/\s/.test(spec)) return problem('diag.userSpace');
  const parts = spec.replace(/\$\{[^}]*\}/g, '$V').split(':');
  if (parts.length > 2) return problem('diag.userColon');
  for (const part of parts) {
    if (part === '') return problem('diag.userEmpty');
    if (VAR_ONLY.test(part)) continue;
    if (!ID.test(part)) return problem('diag.userBad', part);
    if (/^\d+$/.test(part) && Number(part) > 2147483647) return problem('diag.userRange', part);
  }
  return null;
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function createsUser(command, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:useradd|adduser)\\b[^;&|]*(?<![\\w-])${esc}(?![\\w-])`).test(command)
    || new RegExp(`${esc}:[^\\s]*:\\d+:\\d+`).test(command);
}

export function validate(text, options = {}) {
  const sim = options.sim ?? simulate(text, options);
  const { parsed, globals, rawStages: stages } = sim;
  const t = translator(options.lang);
  const out = [];
  const add = (severity, line, code, key, params) => out.push({ severity, line, message: t(key, params), code });
  const error = (line, code, key, params) => add('error', line, code, key, params);
  const warn = (line, code, key, params) => add('warning', line, code, key, params);
  const info = (line, code, key, params) => add('info', line, code, key, params);
  const userProblem = ({ key, params }) => t(key, params);

  for (const issue of parsed.issues) add(issue.severity ?? 'error', issue.line, 'parse', issue.key, issue.params);

  // Which stage each instruction belongs to, so Windows rules apply per stage.
  const windowsLines = new Set();
  for (const stage of stages) {
    if (sim.stages[stage.index].os !== 'windows') continue;
    for (const ins of [stage.from, ...stage.instructions]) windowsLines.add(ins.startLine);
  }

  if (stages.length === 0) error(1, 'no-from', 'diag.noFrom');
  for (const ins of globals) {
    if (ins.keyword !== 'ARG' && INSTRUCTIONS.includes(ins.keyword)) {
      error(ins.startLine, 'before-from', 'diag.beforeFrom', { kw: ins.keyword });
    }
  }

  const upper = parsed.instructions.filter((i) => i.rawKeyword === i.keyword).length;
  const majorityUpper = upper >= parsed.instructions.length / 2;
  for (const ins of parsed.instructions) {
    const consistent = majorityUpper ? ins.rawKeyword === ins.keyword : ins.rawKeyword === ins.keyword.toLowerCase();
    if (INSTRUCTIONS.includes(ins.keyword) && !consistent) info(ins.startLine, 'casing', 'diag.casing', { kw: ins.rawKeyword });
    checkInstruction(ins);
  }

  function checkInstruction(ins, onbuild = false) {
    const line = ins.startLine;
    const { keyword, args } = ins;
    const windows = windowsLines.has(line);
    const unsupported = (feature) => error(line, 'windows', 'diag.winUnsupported', { feature });
    if (!INSTRUCTIONS.includes(keyword)) {
      const near = INSTRUCTIONS.map((k) => [k, distance(k, keyword)]).sort((a, b) => a[1] - b[1])[0];
      error(line, 'unknown', near[1] <= 2 ? 'diag.unknownNear' : 'diag.unknown', { kw: ins.rawKeyword, near: near[0] });
      return;
    }
    if (args === '') { error(line, 'empty', 'diag.emptyArgs', { kw: keyword }); return; }

    const { flags, rest } = splitFlags(args);
    if (FLAGS[keyword]) {
      for (const f of flags) {
        if (!FLAGS[keyword].includes(f.name)) error(line, 'flag', 'diag.flag', { kw: keyword, flag: f.name });
      }
    }
    if (windows) {
      if (ins.heredocs.length) unsupported('heredoc');
      if (flags.some((f) => f.name === 'chmod')) unsupported('--chmod');
      if (keyword === 'RUN' && flags.some((f) => f.name === 'mount')) unsupported('RUN --mount');
      if (parsed.escape === '\\' && /[A-Za-z]:\\/.test(args) && !args.startsWith('[')) warn(line, 'windows', 'diag.winEscape');
    }

    switch (keyword) {
      case 'MAINTAINER':
        warn(line, 'maintainer', 'diag.maintainer');
        break;
      case 'ENV':
      case 'LABEL':
      case 'ARG': {
        const { pairs, legacy, unterminated } = parsePairs(ins, parsed.escape);
        if (unterminated) error(line, 'quote', 'diag.quote');
        if (legacy) {
          if (pairs[0].value === null) error(line, 'pair', 'diag.pairMissing', { kw: keyword, key: pairs[0].key });
          else warn(line, 'legacy-pair', 'diag.legacyPair', { kw: keyword });
        }
        for (const { key, value } of pairs) {
          if (!legacy && keyword !== 'ARG' && value === null) error(line, 'pair', 'diag.pairEq', { key });
          if (keyword !== 'LABEL' && !/^[A-Za-z_]\w*$/.test(key)) error(line, 'var-name', 'diag.varName', { key });
          if (keyword !== 'LABEL' && SECRET_NAME.test(key) && value !== '' && !/_(FILE|PATH)$/i.test(key)) {
            warn(line, 'secret', 'diag.secret', { key });
          }
        }
        break;
      }
      case 'USER': {
        // Windows account names may contain spaces and backslashes.
        const problem = windows ? null : checkUserSpec(args);
        if (problem) error(line, 'user', problem.key, problem.params);
        break;
      }
      case 'WORKDIR':
        if (!args.startsWith('/') && !args.startsWith('$') && !/^("?[A-Za-z]:|\\)/.test(args)) {
          warn(line, 'workdir', 'diag.workdirRel');
        }
        break;
      case 'EXPOSE':
        for (const token of args.split(/\s+/)) {
          if (token.includes('$')) continue;
          const m = token.match(/^(\d+)(?:-(\d+))?(?:\/(\w+))?$/);
          const from = m && Number(m[1]);
          const to = m && Number(m[2] ?? m[1]);
          if (!m || from < 1 || to > 65535 || from > to) error(line, 'port', 'diag.port', { value: token });
          else if (m[3] && !['tcp', 'udp', 'sctp'].includes(m[3].toLowerCase())) error(line, 'port', 'diag.proto', { value: token });
        }
        break;
      case 'CMD':
      case 'ENTRYPOINT': {
        const exec = parseExecForm(args);
        if (exec.form === 'invalid') warn(line, 'json', 'diag.jsonShell', { kw: keyword, reason: t(exec.reason) });
        else if (exec.form === 'shell') info(line, 'shell-form', 'diag.shellForm', { kw: keyword });
        break;
      }
      case 'SHELL': {
        const exec = parseExecForm(args);
        if (exec.form !== 'exec' || exec.value.length === 0) error(line, 'json', 'diag.shellJson');
        break;
      }
      case 'VOLUME': {
        const exec = parseExecForm(args);
        if (exec.form === 'invalid') error(line, 'json', 'diag.jsonError', { kw: 'VOLUME', reason: t(exec.reason) });
        break;
      }
      case 'STOPSIGNAL':
        if (!args.includes('$') && !SIGNALS.test(args)) error(line, 'signal', 'diag.signal', { value: args });
        break;
      case 'HEALTHCHECK': {
        if (/^NONE$/i.test(rest)) break;
        if (!/^CMD(\s+|$)/i.test(rest)) error(line, 'healthcheck', 'diag.healthForm');
        else if (rest.replace(/^CMD\s*/i, '') === '') error(line, 'healthcheck', 'diag.healthCmd');
        for (const f of flags) {
          if (f.name === 'retries' ? !/^\d+$/.test(f.value ?? '') : !/^(\d+(\.\d+)?(ms|s|m|h))+$|^0$/.test(f.value ?? '')) {
            error(line, 'healthcheck', 'diag.healthFlag', { flag: f.name, value: f.value });
          }
        }
        break;
      }
      case 'COPY':
      case 'ADD': {
        const exec = parseExecForm(rest);
        if (exec.form === 'invalid') { error(line, 'json', 'diag.jsonError', { kw: keyword, reason: t(exec.reason) }); break; }
        const { tokens, unterminated } = tokenize(rest, parsed.escape);
        if (unterminated) error(line, 'quote', 'diag.quote');
        const parts = exec.form === 'exec' ? exec.value : tokens.map((t) => t.value);
        if (parts.length < 2) { error(line, 'copy-args', 'diag.copyArgs', { kw: keyword }); break; }
        const sources = parts.slice(0, -1);
        const dest = parts.at(-1);
        if ((sources.length > 1 || sources.some((s) => /[*?]/.test(s))) && !/[/\\]$/.test(dest) && dest !== '.') {
          if (sources.length > 1) error(line, 'copy-dest', 'diag.copyDestMany');
          else warn(line, 'copy-dest', 'diag.copyDestGlob');
        }
        const from = flags.find((f) => f.name === 'from')?.value;
        if (from === undefined && sources.some((s) => s === '..' || s.startsWith('../'))) {
          error(line, 'context', 'diag.context');
        }
        const chown = flags.find((f) => f.name === 'chown')?.value;
        if (chown !== undefined) {
          const problem = checkUserSpec(chown ?? '');
          if (problem) error(line, 'user', 'diag.chown', { problem: userProblem(problem) });
        }
        const chmod = flags.find((f) => f.name === 'chmod')?.value;
        if (chmod && !chmod.includes('$') && !/^[0-7]{3,4}$|^[ugoa]*[+=-][rwxXst]+(,[ugoa]*[+=-][rwxXst]+)*$/.test(chmod)) {
          error(line, 'chmod', 'diag.chmod', { value: chmod });
        }
        if (keyword === 'ADD' && sources.every((s) => !/^(https?:\/\/|git@)|\.(tar|tgz|tar\.\w+)$|\.git(#|$)|^<</.test(s))) {
          info(line, 'add', 'diag.addCopy');
        }
        break;
      }
      case 'RUN': {
        const body = [rest, ...ins.heredocs.flatMap((d) => d.lines)].join('\n');
        const exec = parseExecForm(rest);
        if (exec.form === 'invalid') warn(line, 'json', 'diag.jsonShell', { kw: 'RUN', reason: t(exec.reason) });
        if (windows) break;
        if (/apt-get\s+(?:-\S+\s+)*install\b/.test(body)) {
          if (!/apt-get[^;&|\n]*\s(-\w*y\w*|--yes|--assume-yes|-qq)\b/.test(body)) warn(line, 'apt-yes', 'diag.aptYes');
          if (!/apt-get[^;&|\n]*\bupdate\b/.test(body)) warn(line, 'apt-update', 'diag.aptUpdate');
          if (!body.includes('/var/lib/apt/lists')) info(line, 'apt-clean', 'diag.aptClean');
        }
        if (/apk\s+add\b/.test(body) && !/--no-cache|\/var\/cache\/apk/.test(body)) info(line, 'apk', 'diag.apk');
        if (/(^|&&|;|\|)\s*sudo\s/.test(body)) warn(line, 'sudo', 'diag.sudo');
        if (/^cd\s+[^;&|]+$/.test(rest)) warn(line, 'cd', 'diag.cd');
        break;
      }
      case 'ONBUILD': {
        if (onbuild) break;
        const [, kw, tail = ''] = args.match(/^(\S+)\s*([\s\S]*)$/);
        const upperKw = kw.toUpperCase();
        if (['ONBUILD', 'FROM', 'MAINTAINER'].includes(upperKw)) error(line, 'onbuild', 'diag.onbuild', { kw: upperKw });
        else checkInstruction({ ...ins, keyword: upperKw, rawKeyword: kw, args: tail.trim(), heredocs: [] }, true);
        break;
      }
      default:
        break;
    }
  }

  const names = new Map();
  for (const stage of stages) {
    const line = stage.from.startLine;
    const result = sim.stages[stage.index];
    if (stage.from.args === '') continue;
    const unknownFlags = stage.flags.filter((f) => !f.startsWith('--platform='));
    if (unknownFlags.length) error(line, 'flag', 'diag.fromFlags', { flags: unknownFlags.join(' ') });
    if (stage.malformed || !stage.image) {
      error(line, 'from-syntax', 'diag.fromSyntax');
    }
    if (stage.name) {
      const lower = stage.name.toLowerCase();
      if (!/^[a-z][a-z0-9_.-]*$/i.test(stage.name)) error(line, 'stage-name', 'diag.stageName', { name: stage.name });
      if (stage.name !== lower) warn(line, 'stage-name', 'diag.stageLower', { name: stage.name });
      if (names.has(lower)) error(line, 'stage-dup', 'diag.stageDup', { name: stage.name, line: names.get(lower) });
      names.set(lower, line);
    }

    const baseRef = result.baseRef;
    const missing = sim.undefinedVars.filter((v) => v.inFrom && v.stage === stage.index);
    for (const v of missing) error(line, 'from-var', 'diag.fromVar', { name: v.name });
    if (missing.length === 0 && result.parentIndex === null && baseRef !== 'scratch' && stage.image) {
      const later = stages.slice(stage.index).find((s) => s.name?.toLowerCase() === baseRef.toLowerCase());
      if (baseRef === '') error(line, 'from-empty', 'diag.fromEmpty');
      else if (later) error(line, 'stage-order', 'diag.stageLater', { name: baseRef });
      else {
        const ref = parseImageRef(baseRef);
        if (!ref.ok) error(line, 'from-ref', 'diag.fromRef', { error: t(ref.key, ref.params) });
        else if (!ref.digest && ref.tag === 'latest') {
          warn(line, 'latest', ref.explicitTag ? 'diag.latestExplicit' : 'diag.latestImplicit');
        }
      }
    }

    // COPY --from / RUN --mount from=
    for (const ins of stage.instructions) {
      if (ins.keyword !== 'COPY' && ins.keyword !== 'RUN') continue;
      const refs = splitFlags(ins.args).flags.flatMap((f) => {
        if (ins.keyword === 'COPY' && f.name === 'from') return [f.value ?? ''];
        if (f.name === 'mount') return (f.value ?? '').split(',').filter((p) => p.startsWith('from=')).map((p) => p.slice(5));
        return [];
      });
      for (const ref of refs) {
        if (ref.includes('$')) {
          if (ins.keyword === 'COPY') error(ins.startLine, 'copy-from', 'diag.copyVar');
          continue;
        }
        if (findStage(stages, ref, stage.index)) continue;
        const self = ref.toLowerCase() === stage.name?.toLowerCase() || ref === String(stage.index);
        if (self) error(ins.startLine, 'copy-from', 'diag.selfRef', { ref });
        else if (findStage(stages, ref)) error(ins.startLine, 'stage-order', 'diag.stageLater', { name: ref });
        else if (/^\d+$/.test(ref)) error(ins.startLine, 'copy-from', 'diag.noStageNumber', { ref });
        else if (!parseImageRef(ref).ok) error(ins.startLine, 'copy-from', 'diag.copyFromBad', { ref });
        else info(ins.startLine, 'external-from', 'diag.external', { ref });
      }
    }

    for (const kw of ['CMD', 'ENTRYPOINT', 'HEALTHCHECK']) {
      const list = stage.instructions.filter((i) => i.keyword === kw);
      for (const ins of list.slice(0, -1)) warn(ins.startLine, 'override', 'diag.override', { kw });
    }
  }

  for (const v of sim.undefinedVars) {
    if (v.inFrom) continue;
    const isGlobal = sim.globalArgs.some((a) => a.key === v.name);
    const params = { name: v.name };
    if (isGlobal) warn(v.line, 'global-arg', 'diag.globalArg', params);
    else if (AUTOMATIC_ARGS.includes(v.name)) warn(v.line, 'auto-arg', 'diag.autoArg', params);
    else if (v.baseKnown) warn(v.line, 'undefined-var', 'diag.undefinedVar', params);
    else info(v.line, 'undefined-var', 'diag.undefinedMaybe', params);
  }

  sim.stages.forEach((s) => {
    if (!sim.used.has(s.index) && s.index < sim.targetIndex) {
      warn(stages[s.index].from.startLine, 'unused-stage', 'diag.unusedStage', { name: s.name ?? s.index });
    }
  });

  const final = sim.stages[sim.targetIndex];
  if (final) {
    const line = stages[final.index].from.startLine;
    const user = final.state.user;
    const userLine = findUserLine(final.index);
    if (final.os === 'windows') {
      if (/^containeradministrator$/i.test(user ?? '')) warn(userLine ?? line, 'root', 'diag.winAdmin');
    } else if (user !== null && /^(root|0)(:|$)/.test(user)) warn(userLine ?? line, 'root', 'diag.rootUser');
    else if (user === null && final.baseRef !== 'scratch') {
      if (final.baseKnown) warn(line, 'root', 'diag.rootNoUser');
      else info(line, 'root', 'diag.rootMaybe');
    }
  }

  // Check that a USER given by name is actually created
  for (const stage of stages) {
    if (sim.stages[stage.index].os === 'windows') continue;
    for (const ins of stage.instructions.filter((i) => i.keyword === 'USER')) {
      const name = ins.args.split(':')[0];
      if (!/^[a-zA-Z_][\w.-]*$/.test(name) || ['root', 'nobody', 'node', 'www-data', 'nonroot', 'daemon'].includes(name)) continue;
      let current = sim.stages[stage.index];
      let created = false;
      while (current && !created) {
        created = stages[current.index].instructions.some((i) => i.keyword === 'RUN'
          && (current.index !== stage.index || i.startLine < ins.startLine)
          && createsUser([i.args, ...i.heredocs.flatMap((d) => d.lines)].join(' '), name));
        current = current.parentIndex === null ? null : sim.stages[current.parentIndex];
      }
      if (!created) info(ins.startLine, 'user-missing', 'diag.userMissing', { name });
    }
  }

  function findUserLine(index) {
    let current = sim.stages[index];
    while (current) {
      const ins = stages[current.index].instructions.findLast((i) => i.keyword === 'USER');
      if (ins) return ins.startLine;
      current = current.parentIndex === null ? null : sim.stages[current.parentIndex];
    }
    return null;
  }

  const rank = { error: 0, warning: 1, info: 2 };
  const seen = new Set();
  return out
    .filter((d) => {
      const key = `${d.severity}|${d.line}|${d.message}`;
      return seen.has(key) ? false : seen.add(key);
    })
    .sort((a, b) => a.line - b.line || rank[a.severity] - rank[b.severity]);
}
