// Interprets instructions without building and computes the final state of every stage.

import { parse, splitStages, parsePairs, splitFlags, parseExecForm, tokenize } from './parser.js';
import { expand } from './vars.js';
import { stageOs } from './platforms.js';

// ARGs the builder provides without declaration
const PREDEFINED = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'ftp_proxy', 'no_proxy', 'all_proxy',
];
export const AUTOMATIC_ARGS = [
  'TARGETPLATFORM', 'TARGETOS', 'TARGETARCH', 'TARGETVARIANT',
  'BUILDPLATFORM', 'BUILDOS', 'BUILDARCH', 'BUILDVARIANT', 'TARGETSTAGE',
];

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function automaticValues(platform) {
  const [os = 'linux', arch = 'amd64', variant = ''] = platform.split('/');
  return {
    TARGETPLATFORM: platform, TARGETOS: os, TARGETARCH: arch, TARGETVARIANT: variant,
    BUILDPLATFORM: platform, BUILDOS: os, BUILDARCH: arch, BUILDVARIANT: variant,
  };
}

export function joinPath(base, path, windows = false) {
  if (windows) return joinWindowsPath(base, path);
  const full = path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`;
  const out = [];
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}${path.endsWith('/') && out.length ? '/' : ''}`;
}

function joinWindowsPath(base, path) {
  const drive = (p) => p.match(/^[A-Za-z]:/)?.[0] ?? null;
  const slashed = path.replace(/\\/g, '/');
  const letter = drive(slashed) ?? drive(base) ?? 'C:';
  const rest = slashed.replace(/^[A-Za-z]:/, '');
  const parent = base.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const joined = joinPath(parent || '/', rest || (drive(slashed) ? '/' : '.'));
  return `${letter}${joined.replace(/\//g, '\\')}`;
}

function emptyState() {
  return {
    env: new Map(), args: new Map(), labels: new Map(), expose: new Set(), volumes: new Set(),
    user: null, workdir: null, entrypoint: null, cmd: null, healthcheck: null,
    shell: null, stopsignal: null, onbuild: [], files: [], layers: [],
  };
}

function inherit(parent) {
  return {
    env: new Map(parent.env), args: new Map(parent.args), labels: new Map(parent.labels),
    expose: new Set(parent.expose), volumes: new Set(parent.volumes),
    user: parent.user, workdir: parent.workdir, entrypoint: parent.entrypoint, cmd: parent.cmd,
    healthcheck: parent.healthcheck, shell: parent.shell, stopsignal: parent.stopsignal,
    onbuild: [], files: [...parent.files], layers: [...parent.layers],
  };
}

// Turns an image config read from the registry into the initial state.
function fromImageConfig(config) {
  const s = emptyState();
  for (const entry of config.Env ?? []) {
    const eq = entry.indexOf('=');
    s.env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  for (const port of Object.keys(config.ExposedPorts ?? {})) s.expose.add(port);
  for (const v of Object.keys(config.Volumes ?? {})) s.volumes.add(v);
  for (const [k, v] of Object.entries(config.Labels ?? {})) s.labels.set(k, v);
  s.user = config.User || null;
  s.workdir = config.WorkingDir || null;
  s.entrypoint = config.Entrypoint ? { form: 'exec', value: config.Entrypoint } : null;
  s.cmd = config.Cmd ? { form: 'exec', value: config.Cmd } : null;
  s.stopsignal = config.StopSignal || null;
  return s;
}

export function findStage(stages, ref, beforeIndex = stages.length) {
  if (/^\d+$/.test(ref)) {
    const n = Number(ref);
    return n < beforeIndex ? stages[n] ?? null : null;
  }
  const lower = ref.toLowerCase();
  return stages.slice(0, beforeIndex).find((s) => s.name?.toLowerCase() === lower) ?? null;
}

/**
 * @param {string} text
 * @param {{buildArgs?: Record<string,string>, baseConfigs?: Record<string,object>, target?: string|number|null, platform?: string}} options
 */
export function simulate(text, options = {}) {
  const { buildArgs = {}, baseConfigs = {}, target = null, platform = 'linux/amd64' } = options;
  const parsed = parse(text);
  const { globals, stages } = splitStages(parsed);
  const auto = automaticValues(platform);
  const undefinedVars = []; // {line, name, stage}

  const globalScope = new Map(Object.entries(auto));
  const globalArgs = [];
  for (const ins of globals) {
    if (ins.keyword !== 'ARG') continue;
    for (const { key, value } of parsePairs(ins, parsed.escape).pairs) {
      const resolved = Object.hasOwn(buildArgs, key) ? buildArgs[key]
        : value === null ? null : expand(value, globalScope);
      globalScope.set(key, resolved);
      globalArgs.push({ key, value: resolved, line: ins.startLine });
    }
  }

  const results = [];
  for (const stage of stages) {
    const missing = new Set();
    const baseRef = expand(stage.image, globalScope, missing);
    for (const name of missing) undefinedVars.push({ line: stage.from.startLine, name, stage: stage.index, inFrom: true });

    const parent = findStage(stages, baseRef, stage.index);
    const parentResult = parent && !/^\d+$/.test(baseRef) ? results[parent.index] : null;
    let state;
    let baseKnown;
    if (parentResult) {
      state = inherit(parentResult.state);
      baseKnown = parentResult.baseKnown;
    } else if (baseRef === 'scratch') {
      state = emptyState();
      baseKnown = true;
    } else if (baseConfigs[baseRef]) {
      state = fromImageConfig(baseConfigs[baseRef]);
      baseKnown = true;
    } else {
      state = emptyState();
      baseKnown = false;
    }

    // ONBUILD triggers run in images that use this one as FROM.
    const stagePlatform = stage.platform ? expand(stage.platform, globalScope) : null;
    const os = stageOs({ platform: stagePlatform, baseRef, parentOs: parentResult?.os, target: platform });
    const windows = os === 'windows';
    const deps = new Set(parentResult ? [parentResult.index] : []);
    const externalFrom = [];
    let cmdSetHere = false;

    const lookup = () => {
      const scope = new Map();
      if (!windows) {
        if (!state.env.has('PATH')) scope.set('PATH', DEFAULT_PATH);
        scope.set('HOME', '/root');
      }
      for (const name of PREDEFINED) scope.set(name, buildArgs[name] ?? '');
      for (const [k, v] of state.args) scope.set(k, v);
      for (const [k, v] of state.env) scope.set(k, v);
      return scope;
    };
    const sub = (value, ins, scope = lookup()) => {
      const miss = new Set();
      const out = expand(value, scope, miss);
      for (const name of miss) {
        undefinedVars.push({ line: ins.startLine, name, stage: stage.index, baseKnown });
      }
      return out;
    };
    const layer = (ins, summary, kind = 'fs') => {
      state.layers.push({ keyword: ins.keyword, line: ins.startLine, summary, kind, stage: stage.index });
    };
    const addDep = (ref) => {
      const dep = findStage(stages, ref, stage.index);
      if (dep) deps.add(dep.index);
      else externalFrom.push(ref);
      return dep;
    };

    for (const ins of stage.instructions) {
      switch (ins.keyword) {
        case 'ARG':
          for (const { key, value } of parsePairs(ins, parsed.escape).pairs) {
            let resolved = null;
            if (Object.hasOwn(buildArgs, key)) resolved = buildArgs[key];
            else if (value !== null) resolved = sub(value, ins);
            else if (globalScope.has(key)) resolved = globalScope.get(key);
            else if (state.args.has(key)) resolved = state.args.get(key);
            else if (PREDEFINED.includes(key)) resolved = '';
            state.args.set(key, resolved);
          }
          break;
        case 'ENV': {
          const { pairs } = parsePairs(ins, parsed.escape);
          // Values within one ENV expand against the state before the instruction.
          const scope = lookup();
          const next = pairs.map(({ key, value }) => [key, sub(value ?? '', ins, scope)]);
          for (const [k, v] of next) state.env.set(k, v);
          break;
        }
        case 'LABEL': {
          const scope = lookup();
          for (const { key, value } of parsePairs(ins, parsed.escape).pairs) state.labels.set(key, sub(value ?? '', ins, scope));
          break;
        }
        case 'MAINTAINER':
          state.labels.set('maintainer', ins.args);
          break;
        case 'USER':
          state.user = sub(ins.args, ins) || null;
          break;
        case 'WORKDIR':
          state.workdir = joinPath(state.workdir ?? (windows ? 'C:\\' : '/'), sub(ins.args, ins), windows);
          layer(ins, `mkdir ${state.workdir}`);
          break;
        case 'EXPOSE':
          for (const token of sub(ins.args, ins).split(/\s+/).filter(Boolean)) {
            state.expose.add(token.includes('/') ? token.toLowerCase() : `${token}/tcp`);
          }
          break;
        case 'VOLUME': {
          const exec = parseExecForm(ins.args);
          const list = exec.form === 'exec' ? exec.value : ins.args.split(/\s+/).filter(Boolean);
          for (const v of list) state.volumes.add(sub(v, ins));
          break;
        }
        case 'RUN': {
          const { flags, rest } = splitFlags(ins.args);
          for (const flag of flags.filter((f) => f.name === 'mount')) {
            const from = flag.value?.split(',').find((p) => p.startsWith('from='));
            if (from) addDep(from.slice(5));
          }
          const body = ins.heredocs.length ? ins.heredocs.flatMap((d) => d.lines).join(' ; ') : rest;
          layer(ins, body.replace(/\s+/g, ' ').trim());
          break;
        }
        case 'COPY':
        case 'ADD': {
          const { flags, rest } = splitFlags(ins.args);
          const exec = parseExecForm(rest);
          const parts = exec.form === 'exec' ? exec.value : tokenize(rest, parsed.escape).tokens.map((t) => t.value);
          if (parts.length < 2) break;
          const sources = parts.slice(0, -1).map((p) => sub(p, ins));
          const rawDest = sub(parts.at(-1), ins);
          const dest = joinPath(state.workdir ?? (windows ? 'C:\\' : '/'), rawDest === '.' ? './' : rawDest, windows);
          const fromFlag = flags.find((f) => f.name === 'from')?.value ?? null;
          let origin = { type: 'context' };
          if (fromFlag !== null) {
            const dep = addDep(fromFlag);
            origin = dep ? { type: 'stage', name: dep.name ?? `#${dep.index}` } : { type: 'image', name: fromFlag };
          }
          const chown = flags.find((f) => f.name === 'chown')?.value ?? null;
          const chmod = flags.find((f) => f.name === 'chmod')?.value ?? null;
          for (const src of sources) {
            state.files.push({ src: src.startsWith('<<') ? '(heredoc)' : src, dest, origin, chown, chmod, line: ins.startLine, stage: stage.index });
          }
          layer(ins, `${origin.name ? `${origin.name}: ` : ''}${sources.join(', ')} → ${dest}`);
          break;
        }
        case 'CMD':
          state.cmd = toCommand(ins.args);
          cmdSetHere = true;
          break;
        case 'ENTRYPOINT':
          state.entrypoint = toCommand(ins.args);
          // Setting ENTRYPOINT resets a CMD inherited from the parent.
          if (!cmdSetHere) state.cmd = null;
          break;
        case 'HEALTHCHECK':
          state.healthcheck = /^NONE$/i.test(ins.args) ? null : ins.args;
          break;
        case 'SHELL': {
          const exec = parseExecForm(ins.args);
          if (exec.form === 'exec') state.shell = exec.value;
          break;
        }
        case 'STOPSIGNAL':
          state.stopsignal = sub(ins.args, ins);
          break;
        case 'ONBUILD':
          state.onbuild.push(ins.args);
          break;
        default:
          break;
      }
    }

    results.push({
      index: stage.index, name: stage.name, platform: stagePlatform, rawPlatform: stage.platform, os,
      image: stage.image, baseRef, baseKnown, state,
      parentIndex: parentResult ? parentResult.index : null,
      deps: [...deps].sort((a, b) => a - b), externalFrom,
      startLine: stage.startLine, endLine: stage.endLine,
    });
  }

  let targetIndex = results.length - 1;
  if (target !== null && target !== '' && results.length) {
    const found = findStage(stages, String(target));
    if (found) targetIndex = found.index;
  }
  const used = new Set();
  const visit = (i) => {
    if (i < 0 || used.has(i)) return;
    used.add(i);
    results[i].deps.forEach(visit);
  };
  visit(targetIndex);

  return { parsed, globals, rawStages: stages, globalArgs, stages: results, targetIndex, used, undefinedVars };
}

function toCommand(args) {
  const exec = parseExecForm(args);
  return exec.form === 'exec' ? { form: 'exec', value: exec.value } : { form: 'shell', value: args };
}

// Final process (argv) when the container runs without arguments
export function effectiveCommand(state, os = 'linux') {
  const shell = state.shell ?? (os === 'windows' ? ['cmd', '/S', '/C'] : ['/bin/sh', '-c']);
  const argv = (c) => (c === null ? [] : c.form === 'exec' ? c.value : [...shell, c.value]);
  if (state.entrypoint?.form === 'shell') return argv(state.entrypoint);
  return [...argv(state.entrypoint), ...argv(state.cmd)];
}
