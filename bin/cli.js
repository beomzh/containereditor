// Command line interface. main() returns the exit code:
// 0 ok · 1 problems found · 2 usage error · 3 build failed

import { parseArgs } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INSTRUCTIONS, parsePairs } from '../public/core/parser.js';
import { simulate, effectiveCommand, findStage } from '../public/core/simulator.js';
import { validate } from '../public/core/validator.js';
import { compatibility, PLATFORMS } from '../public/core/platforms.js';
import * as ops from '../public/core/editor-ops.js';
import { TEMPLATES } from '../public/core/templates.js';
import { translator, normalizeLang, LocalizedError } from '../public/core/i18n.js';
import { createChecker } from '../server/registry.js';
import { detectEngine, planBuild, runBuild, commandLines } from '../server/builder.js';
import { serve } from '../server/server.js';

const OPTIONS = {
  lang: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  stage: { type: 'string' }, platform: { type: 'string' }, target: { type: 'string' },
  'build-arg': { type: 'string', multiple: true }, online: { type: 'boolean' },
  json: { type: 'boolean' }, strict: { type: 'boolean' }, stdout: { type: 'boolean' }, force: { type: 'boolean' },
  out: { type: 'string', short: 'o' }, name: { type: 'string' }, base: { type: 'string' }, copy: { type: 'string' }, line: { type: 'string' },
  context: { type: 'string' }, output: { type: 'string' }, tag: { type: 'string', short: 't' }, dest: { type: 'string' },
  engine: { type: 'string' }, 'dry-run': { type: 'boolean' },
  port: { type: 'string' }, 'allow-build': { type: 'boolean' }, workspace: { type: 'string' },
};
const PAIRED = ['ARG', 'ENV', 'LABEL'];

export async function main(argv, io = {}) {
  const {
    out = (s) => process.stdout.write(`${s}\n`),
    err = (s) => process.stderr.write(`${s}\n`),
    raw = (s) => process.stdout.write(s),
    cwd = process.cwd(),
    env = process.env,
    checkImage = createChecker(),
  } = io;
  let lang = normalizeLang(env.DOCKEREDITOR_LANG);
  let t = translator(lang);
  const usage = () => t('cli.usage', { templates: Object.keys(TEMPLATES).join(', ') });

  let args;
  try {
    args = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    err(e.message);
    err(usage());
    return 2;
  }
  const { values, positionals } = args;
  lang = normalizeLang(values.lang ?? env.DOCKEREDITOR_LANG);
  t = translator(lang);
  const [command, ...rest] = positionals;

  if (values.version) {
    out(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  if (!command || values.help) { out(usage()); return command || values.help ? 0 : 2; }

  const need = (value, what) => {
    if (value === undefined || value === '') throw new LocalizedError('cli.missingArg', { what });
    return value;
  };
  const buildArgs = Object.fromEntries((values['build-arg'] ?? []).map((a) => {
    const eq = a.indexOf('=');
    return eq < 0 ? [a, env[a] ?? ''] : [a.slice(0, eq), a.slice(eq + 1)];
  }));
  const platforms = values.platform?.split(',').map((p) => p.trim()).filter(Boolean);

  async function load(path) {
    const candidates = path ? [path] : ['Dockerfile', 'Containerfile'];
    for (const name of candidates) {
      const full = resolve(cwd, name);
      try {
        const original = await readFile(full, 'utf8');
        return { name, full, original, text: original.replace(/\r\n?/g, '\n') };
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e;
      }
    }
    throw new LocalizedError('cli.noFile', { path: candidates.join(', ') });
  }

  async function writeNew(path, content) {
    const full = resolve(cwd, path);
    try {
      await writeFile(full, content, { flag: values.force ? 'w' : 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') throw new LocalizedError('cli.exists', { path });
      throw e;
    }
    out(t('cli.written', { path }));
  }

  // Looks up every external base image once.
  async function lookupImages(text, platform) {
    const results = new Map();
    const sim = simulate(text, { buildArgs, platform, target: values.target ?? null });
    const refs = sim.stages.filter((s) => s.parentIndex === null && s.baseRef && s.baseRef !== 'scratch' && !s.baseRef.includes('$'));
    await Promise.all([...new Set(refs.map((s) => s.baseRef))].map(async (ref) => results.set(ref, await checkImage(ref, platform))));
    return results;
  }

  async function analyze(text, online) {
    const platform = platforms?.[0] ?? 'linux/amd64';
    const results = online ? await lookupImages(text, platform) : new Map();
    const baseConfigs = Object.fromEntries([...results].filter(([, r]) => r.config).map(([ref, r]) => [ref, r.config]));
    const sim = simulate(text, { buildArgs, platform, target: values.target ?? null, baseConfigs });
    return { sim, results, platform, diagnostics: validate(text, { sim, lang }) };
  }

  const printDiagnostics = (name, diagnostics) => {
    for (const d of diagnostics) out(`${name}:${d.line}: ${t(`ui.${d.severity}`)}: ${d.message}`);
  };
  const count = (list, severity) => list.filter((d) => d.severity === severity).length;

  const commands = {
    async validate() {
      const file = await load(rest[0]);
      const { diagnostics } = await analyze(file.text, values.online);
      if (values.json) out(JSON.stringify({ file: file.name, diagnostics }, null, 2));
      else {
        printDiagnostics(file.name, diagnostics);
        out(t('cli.summary', { path: file.name, e: count(diagnostics, 'error'), w: count(diagnostics, 'warning'), i: count(diagnostics, 'info') }));
      }
      return count(diagnostics, 'error') || (values.strict && count(diagnostics, 'warning')) ? 1 : 0;
    },

    async check() {
      const file = await load(rest[0]);
      const { sim, results } = await analyze(file.text, true);
      const compat = compatibility(sim, (ref) => results.get(ref), PLATFORMS);
      // With --platform the exit code requires those platforms; otherwise only that images exist.
      const wanted = platforms ?? [];
      const failed = [...results.values()].some((r) => r.status !== 'exists' && r.status !== 'blocked')
        || wanted.some((p) => compat.summary[PLATFORMS.indexOf(p)] !== true);
      if (values.json) {
        out(JSON.stringify({ images: Object.fromEntries([...results].map(([ref, { config, ...r }]) => [ref, r])), compatibility: compat }, null, 2));
        return failed ? 1 : 0;
      }
      for (const [ref, r] of results) {
        if (r.status === 'exists') out(`✓ ${t('ui.exists', { ref })}`);
        else {
          out(`${r.status === 'blocked' ? '?' : '✗'} ${ref}: ${t(r.key, r.params)}`);
          if (r.suggestions?.length) out(`  ${t('ui.similar')} ${r.suggestions.join(', ')}`);
        }
      }
      const mark = (v) => (v === true ? '✓' : v === false ? '✗' : '?');
      const rows = [
        ['', ...PLATFORMS],
        ...compat.rows.map((r) => [`${r.name ?? `#${r.index}`} ${r.ref}`, ...r.cells.map(mark)]),
        [t('ui.compatAll'), ...compat.summary.map(mark)],
      ];
      // East Asian characters take two terminal columns.
      const columns = (s) => [...s].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(c) ? 2 : 1), 0);
      const width = Math.max(...rows.map((r) => columns(r[0])));
      out(`\n${t('ui.compatTitle')}`);
      for (const [head, ...cells] of rows) out(`${head}${' '.repeat(width - columns(head))}  ${cells.map((c, i) => c.padEnd(PLATFORMS[i].length)).join('  ')}`);
      out(t('ui.compatLegend'));
      return failed ? 1 : 0;
    },

    async preview() {
      const file = await load(rest[0]);
      const { sim, diagnostics } = await analyze(file.text, values.online);
      const final = sim.stages[sim.targetIndex];
      if (!final) { out(t('ui.noStage')); return 1; }
      const s = final.state;
      const label = (x) => x.name ?? `#${x.index}`;
      const unknown = final.baseKnown ? t('ui.none') : t('ui.fromBase');
      if (values.json) {
        out(JSON.stringify({
          target: label(final), base: final.baseRef, os: final.os, command: effectiveCommand(s, final.os),
          user: s.user, workdir: s.workdir, expose: [...s.expose], volumes: [...s.volumes],
          env: Object.fromEntries(s.env), labels: Object.fromEntries(s.labels), files: s.files, layers: s.layers,
          stages: sim.stages.map((x) => ({ name: label(x), base: x.baseRef, os: x.os, dependsOn: x.deps.map((i) => label(sim.stages[i])), built: sim.used.has(x.index) })),
        }, null, 2));
        return 0;
      }
      out(t('ui.flow'));
      for (const x of sim.stages) {
        const from = x.deps.length ? ` ← ${x.deps.map((i) => label(sim.stages[i])).join(', ')}` : '';
        out(`  ${sim.used.has(x.index) ? '●' : '○'} ${label(x)} (${x.baseRef})${from}${sim.used.has(x.index) ? '' : ` ${t('ui.skipped')}`}`);
      }
      out(`\n${t('ui.finalImage', { name: label(final) })}`);
      const command = effectiveCommand(s, final.os);
      out(`  ${t('ui.process')}: ${command.length ? JSON.stringify(command) : unknown}`);
      out(`  USER: ${s.user ?? unknown}`);
      out(`  WORKDIR: ${s.workdir ?? unknown}`);
      out(`  EXPOSE: ${[...s.expose].join(', ') || unknown}`);
      out(`  ENV:\n${[...s.env].map(([k, v]) => `    ${k}=${v}`).join('\n') || `    ${unknown}`}`);
      out(`  ${t('ui.files')}:`);
      for (const f of s.files) out(`    ${f.dest} ← ${f.src} (${f.origin.name ?? t('ui.buildContext')})`);
      if (!s.files.length) out(`    ${t('ui.noCopy')}`);
      const errors = count(diagnostics, 'error');
      if (errors) err(t('ui.hasErrors', { n: errors }));
      out(`\n${t('ui.previewNote')}`);
      return 0;
    },

    async new() {
      const name = rest[0] ?? 'blank';
      if (!Object.hasOwn(TEMPLATES, name)) throw new LocalizedError('cli.missingArg', { what: `template (${Object.keys(TEMPLATES).join(', ')})` });
      if (values.stdout) raw(TEMPLATES[name]);
      else await writeNew(values.out ?? 'Dockerfile', TEMPLATES[name]);
      return 0;
    },

    add: () => editFile(rest[0], (text, stage) => {
      const keyword = need(rest[1], 'INSTRUCTION').toUpperCase();
      if (!INSTRUCTIONS.includes(keyword) || keyword === 'FROM') throw new LocalizedError('cli.missingArg', { what: 'INSTRUCTION' });
      const value = need(rest.slice(2).join(' '), 'value');
      if (!PAIRED.includes(keyword)) return ops.addInstruction(text, stage(), ops.buildLine(keyword, value));
      return ops.addInstruction(text, stage(), pairLine(keyword, value));
    }),

    set: () => editFile(rest[0], (text, stage) => {
      const keyword = need(rest[1], 'ARG|ENV|LABEL').toUpperCase();
      if (!PAIRED.includes(keyword)) throw new LocalizedError('cli.missingArg', { what: 'ARG|ENV|LABEL' });
      const [key, value] = splitPair(keyword, need(rest[2], 'KEY=VALUE'));
      const found = pairsIn(text, stage(), keyword).find((p) => p.key === key);
      return found ? ops.setPair(text, found.line, found.index, { key, value }) : ops.addInstruction(text, stage(), pairLine(keyword, rest[2]));
    }),

    remove: () => editFile(rest[0], (text, stage) => {
      const keyword = need(rest[1], 'INSTRUCTION').toUpperCase();
      const name = rest[2];
      let result = text;
      // Line numbers move after each removal, so look the next match up again.
      for (;;) {
        if (PAIRED.includes(keyword)) {
          const found = pairsIn(result, stage(result), keyword).find((p) => p.key === need(name, 'name'));
          if (!found) break;
          result = ops.setPair(result, found.line, found.index, null);
        } else {
          const found = instructionsIn(result, stage(result))
            .find((i) => i.keyword === keyword && keyword !== 'FROM' && (!name || i.args === name));
          if (!found) break;
          result = ops.removeInstruction(result, found.startLine);
        }
      }
      if (result === text) throw new LocalizedError('edit.noMatch', { what: [keyword, name].filter(Boolean).join(' ') });
      return result;
    }),

    from: () => editFile(rest[0], (text, stage) => ops.setStageFrom(text, stage(), {
      image: need(rest[1], 'image'), ...(values.name !== undefined ? { name: values.name } : {}),
    })),

    async stage() {
      const [action, path] = rest;
      need(path, 'file');
      if (action === 'extract') {
        const file = await load(path);
        const result = ops.extractStage(file.text, stageIndex(file.text));
        if (values.out) await writeNew(values.out, result);
        else raw(result);
        return 0;
      }
      const actions = {
        add: (text) => ops.addStage(text, { image: need(values.base, '--base'), name: values.name }),
        remove: (text) => ops.removeStage(text, (need(values.stage, '--stage'), stageIndex(text))),
        rename: (text) => ops.setStageFrom(text, stageIndex(text), { name: need(values.name, '--name') }),
        split: (text) => ops.splitStage(text, Number(need(values.line, '--line')), { name: need(values.name, '--name'), base: values.base ?? '', copyPath: values.copy ?? '' }),
      };
      if (!Object.hasOwn(actions, action)) throw new LocalizedError('cli.unknownCommand', { value: `stage ${action ?? ''}` });
      return editFile(path, actions[action]);
    },

    async build() {
      const file = await load(rest[0]);
      const { diagnostics } = await analyze(file.text, false);
      printDiagnostics(file.name, diagnostics.filter((d) => d.severity === 'error'));
      const daemon = await (io.detect ?? detectEngine)(values.engine);
      const plan = await planBuild({
        context: values.context ?? '.', output: values.output ?? 'image', dest: values.dest ?? '', tag: values.tag ?? 'myimage:latest',
        platform: values.platform ?? '', target: values.target ?? '', buildArgs, force: values.force, cwd,
      }, daemon);
      out(`${t('ui.resultWhere')}: ${t(plan.location.key, plan.location.params)}`);
      if (plan.storage && plan.output === 'image') out(`  ${t('build.storage', { path: plan.storage })}`);
      for (const w of plan.warnings) err(t(w.key, w.params));
      for (const line of commandLines(plan, file.name)) out(`$ ${line}`);
      if (values['dry-run']) return 0;
      const outcome = await runBuild(plan, file.text, { onData: raw });
      if (!outcome.ok) { err(t('build.failed', { code: outcome.code })); return 3; }
      out(`\n${t('build.done')}`);
      out(t(plan.location.key, plan.location.params));
      if (outcome.result) {
        out(t(outcome.result.key, outcome.result.params));
        for (const entry of outcome.result.entries ?? []) out(`  ${entry}`);
      }
      return 0;
    },

    async serve() {
      const port = Number(values.port ?? env.PORT ?? 4173);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new LocalizedError('build.badValue', { field: '--port', value: values.port });
      const workspace = resolve(cwd, values.workspace ?? '.');
      if (!(await stat(workspace).catch(() => null))?.isDirectory()) throw new LocalizedError('build.noContext', { path: workspace });
      try {
        const { url } = await serve({ port, allowBuild: values['allow-build'], workspace });
        // The web editor opens in the language chosen with --lang.
        const link = new URL(url);
        if (lang !== 'en') link.searchParams.set('lang', lang);
        out(t('cli.serving', { url: link.href }));
        if (values['allow-build']) err(t('cli.servingBuild', { path: workspace }));
      } catch (e) {
        if (e.code === 'EADDRINUSE') throw new LocalizedError('cli.portInUse', { port });
        throw e;
      }
      return null; // keep running
    },
  };

  const splitPair = (keyword, text) => {
    const eq = text.indexOf('=');
    if (eq >= 0) return [text.slice(0, eq), text.slice(eq + 1)];
    if (keyword === 'ARG') return [text, null];
    throw new LocalizedError('cli.missingArg', { what: 'KEY=VALUE' });
  };
  const pairLine = (keyword, text) => ops.buildPairLine(keyword, ...splitPair(keyword, text));

  function stageIndex(text) {
    const { rawStages } = simulate(text);
    if (values.stage === undefined) {
      if (!rawStages.length) throw new LocalizedError('edit.noStage');
      return rawStages.length - 1;
    }
    if (values.stage === 'global') return -1;
    const found = findStage(rawStages, values.stage);
    if (!found) throw new LocalizedError('edit.noStage');
    return found.index;
  }
  const instructionsIn = (text, index) => {
    const sim = simulate(text);
    return index < 0 ? sim.globals : sim.rawStages[index].instructions;
  };
  const pairsIn = (text, index, keyword) => instructionsIn(text, index)
    .filter((i) => i.keyword === keyword)
    .flatMap((i) => parsePairs(i, simulate(text).parsed.escape).pairs.map((p, n) => ({ key: p.key, line: i.startLine, index: n })));

  // Applies an edit and writes the file back, keeping its line endings.
  async function editFile(path, change) {
    const file = await load(need(path, 'file'));
    const result = change(file.text, (text = file.text) => stageIndex(text));
    if (values.stdout) { raw(result); return 0; }
    await writeFile(file.full, file.original.includes('\r\n') ? result.replace(/\n/g, '\r\n') : result);
    out(t('cli.written', { path: file.name }));
    return 0;
  }

  try {
    if (!Object.hasOwn(commands, command)) throw new LocalizedError('cli.unknownCommand', { value: command });
    return await commands[command]();
  } catch (e) {
    if (e instanceof LocalizedError) { err(t(e.key, e.params)); return 2; }
    err(`error: ${e.message}`);
    return 2;
  }
}
