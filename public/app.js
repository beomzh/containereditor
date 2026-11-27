import { INSTRUCTIONS, parsePairs } from './core/parser.js';
import { simulate, effectiveCommand } from './core/simulator.js';
import { validate } from './core/validator.js';
import * as ops from './core/editor-ops.js';
import { TEMPLATES } from './core/templates.js';
import { LANGUAGES, translate, normalizeLang } from './core/i18n.js';
import { compatibility } from './core/platforms.js';
import { createBuildPanel } from './build-panel.js';

const $ = (id) => document.getElementById(id);
const source = $('source');
const STORE = 'dockereditor.v1';
let lang = 'en';
const t = (key, params) => translate(lang, key, params);

const state = {
  buildArgs: {},
  imageResults: {}, // `${ref}|${platform}` -> server response or {status:'checking'}
  selected: null, // selected stage (build target); null means the last one
  tab: 'preview',
  history: [],
  future: [],
  sim: null,
  diagnostics: [],
};

// ---------- DOM helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

// ---------- document changes ----------
let lastSaved = '';
let typingAt = 0;

function remember(previous) {
  state.history.push(previous);
  if (state.history.length > 200) state.history.shift();
  state.future = [];
}

function setText(text, { record = true } = {}) {
  if (text === source.value) return;
  if (record) remember(source.value);
  source.value = text;
  lastSaved = text;
  refresh();
}

// Edits from the panels; show why when one fails.
function edit(fn) {
  try {
    setText(fn(source.value));
  } catch (e) {
    console.warn('[EDIT] failed:', e);
    toast(e.key ? t(e.key, e.params) : e.message);
    render();
  }
}

source.addEventListener('input', () => {
  const now = Date.now();
  if (now - typingAt > 800) remember(lastSaved);
  typingAt = now;
  lastSaved = source.value;
  refresh();
});

function step(from, to) {
  if (!from.length) return;
  to.push(source.value);
  source.value = from.pop();
  lastSaved = source.value;
  typingAt = 0;
  refresh();
}
const undo = () => step(state.history, state.future);
const redo = () => step(state.future, state.history);

source.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (key === 'y') { e.preventDefault(); redo(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});

// ---------- image check ----------
const platformOf = (stage) => (stage.platform && !stage.platform.includes('$') ? stage.platform : $('platform').value);
const imageKey = (stage) => `${stage.baseRef}|${platformOf(stage)}`;

function externalStages(sim) {
  return sim.stages.filter((s) => s.parentIndex === null && s.baseRef && s.baseRef !== 'scratch' && !s.baseRef.includes('$'));
}

async function checkImages() {
  const targets = new Map(externalStages(state.sim).map((s) => [imageKey(s), s]));
  if (!targets.size) { toast(t('ui.nothingToCheck')); return; }
  $('check').disabled = true;
  for (const key of targets.keys()) state.imageResults[key] = { status: 'checking' };
  refresh();
  await Promise.all([...targets].map(async ([key, stage]) => {
    try {
      const query = new URLSearchParams({ ref: stage.baseRef, platform: platformOf(stage) });
      const res = await fetch(`/api/check-image?${query}`);
      const body = await res.json();
      state.imageResults[key] = body.status ? body : { status: 'error', key: 'reg.http', params: { status: res.status } };
    } catch (e) {
      console.error('[CHECK] failed:', stage.baseRef, e);
      state.imageResults[key] = { status: 'error', key: 'ui.serverDown' };
    }
  }));
  $('check').disabled = false;
  refresh();
}

// ---------- analysis ----------
function analyze() {
  const text = source.value;
  const platform = $('platform').value;
  const options = { buildArgs: state.buildArgs, platform, target: state.selected };
  const first = simulate(text, options);
  const baseConfigs = {};
  for (const stage of externalStages(first)) {
    const result = state.imageResults[imageKey(stage)];
    if (result?.config) baseConfigs[stage.baseRef] = result.config;
  }
  state.sim = simulate(text, { ...options, baseConfigs });
  if (state.selected !== null && state.selected >= state.sim.stages.length) state.selected = null;
  state.diagnostics = validate(text, { sim: state.sim, lang });

  for (const stage of externalStages(state.sim)) {
    const result = state.imageResults[imageKey(stage)];
    const line = state.sim.rawStages[stage.index].from.startLine;
    const params = { ref: stage.baseRef, platform: platformOf(stage) };
    if (result?.status === 'not_found') state.diagnostics.push({ severity: 'error', line, message: t('diag.imageNotFound', params) });
    else if (['auth_required', 'invalid', 'blocked'].includes(result?.status)) state.diagnostics.push({ severity: 'warning', line, message: `${stage.baseRef}: ${t(result.key, result.params)}` });
    else if (result?.platformMissing) state.diagnostics.push({ severity: 'error', line, message: t('diag.platformMissing', params) });
  }
  state.diagnostics.sort((a, b) => a.line - b.line);
}

function refresh() {
  try {
    analyze();
  } catch (e) {
    console.error('[ANALYZE] failed:', e);
    toast(e.message);
  }
  render();
  try {
    localStorage.setItem(STORE, JSON.stringify({ text: source.value, name: $('filename').value }));
  } catch (e) {
    console.warn('[STORE] autosave failed:', e);
  }
}

// ---------- editor rendering ----------
function highlightLine(line) {
  const span = (cls, text) => h('span', { class: cls }, text);
  if (/^\s*#/.test(line)) return [span('com', line)];
  const out = [];
  let rest = line;
  const kw = rest.match(/^(\s*)([A-Za-z]+)(?=\s|$)/);
  if (kw && INSTRUCTIONS.includes(kw[2].toUpperCase())) {
    out.push(kw[1], span('kw', kw[2]));
    rest = rest.slice(kw[0].length);
  }
  const re = /(\$\{[^}]*\}|\$[A-Za-z_]\w*)|("(?:\\.|[^"\\])*")|(\sAS\s)/gi;
  let at = 0;
  for (const m of rest.matchAll(re)) {
    out.push(rest.slice(at, m.index), span(m[1] ? 'var' : m[2] ? 'str' : 'kw', m[0]));
    at = m.index + m[0].length;
  }
  out.push(rest.slice(at));
  return out;
}

function syncScroll() {
  $('highlight').scrollTop = source.scrollTop;
  $('highlight').scrollLeft = source.scrollLeft;
  $('gutter').scrollTop = source.scrollTop;
}
source.addEventListener('scroll', syncScroll);

function renderEditor() {
  const lines = source.value.split('\n');
  const severity = {};
  for (const d of state.diagnostics) {
    if (d.severity === 'error' || (d.severity === 'warning' && severity[d.line] !== 'error')) severity[d.line] = d.severity;
  }
  // The extra lines keep scroll positions aligned with the textarea.
  $('gutter').replaceChildren(...lines.map((_, i) => h('span', { class: severity[i + 1] }, String(i + 1))), h('span', {}, ' '), h('span', {}, ' '));
  $('highlight').replaceChildren(...lines.flatMap((l) => [...highlightLine(l), '\n']), '\n\n');
  syncScroll();
}

function goToLine(line) {
  const lines = source.value.split('\n');
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  source.focus();
  source.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  source.scrollTop = Math.max(0, (line - 5) * 20);
  syncScroll();
}

function renderDiagnostics() {
  const count = (s) => state.diagnostics.filter((d) => d.severity === s).length;
  const errors = count('error');
  $('summary').replaceChildren(
    h('span', { class: errors ? 'text-error' : 'text-ok' }, errors ? t('ui.errors', { n: errors }) : t('ui.noErrors')),
    ` · ${t('ui.counts', { w: count('warning'), i: count('info') })}`,
  );
  $('diagnostics').replaceChildren(...state.diagnostics.map((d) => h('li', {},
    h('button', { class: d.severity, onclick: () => goToLine(d.line) },
      h('span', { class: 'tag' }, t(`ui.${d.severity}`)),
      h('span', { class: 'muted' }, t('ui.line', { line: d.line })),
      h('span', {}, d.message)))));
}

// ---------- left: stages and settings ----------
function imageStatus(stage) {
  if (stage.parentIndex !== null) return h('div', { class: 'image-status muted' }, t('ui.inherits'));
  if (stage.baseRef === 'scratch') return h('div', { class: 'image-status muted' }, t('ui.scratch'));
  const r = state.imageResults[imageKey(stage)];
  if (!r) return h('div', { class: 'image-status muted' }, t('ui.notChecked', { ref: stage.baseRef }));
  if (r.status === 'checking') return h('div', { class: 'image-status muted' }, t('ui.checking'));
  if (r.status === 'exists') {
    if (r.platformMissing) return h('div', { class: 'image-status text-error' }, `✗ ${t('diag.platformMissing', { ref: stage.baseRef, platform: platformOf(stage) })} (${r.platforms?.join(', ')})`);
    const size = r.compressedSize ? ` · ${t('ui.compressed', { size: (r.compressedSize / 1048576).toFixed(1) })}` : '';
    return h('div', { class: 'image-status text-ok', title: r.digest ?? '' },
      `✓ ${t('ui.exists', { ref: stage.baseRef })}${size}${r.configError ? ` (${r.configError})` : ''}`);
  }
  const cls = r.status === 'not_found' || r.status === 'invalid' ? 'text-error' : 'text-warning';
  const mark = r.status === 'not_found' || r.status === 'invalid' ? '✗' : '?';
  return h('div', { class: `image-status ${cls}` }, `${mark} ${t(r.key, r.params)}`,
    r.suggestions?.length ? h('div', { class: 'muted' }, `${t('ui.similar')} `, r.suggestions.map((tag) => h('button', {
      class: 'link',
      onclick: () => {
        const image = state.sim.rawStages[stage.index].image;
        const name = image.split('@')[0];
        const repo = name.lastIndexOf(':') > name.lastIndexOf('/') ? name.slice(0, name.lastIndexOf(':')) : name;
        if (repo.includes('$')) toast(t('ui.editArg'));
        else edit((text) => ops.setStageFrom(text, stage.index, { image: `${repo}:${tag}` }));
      },
    }, `${tag} `))) : null);
}

function pairRows(instructions, keyword) {
  return instructions.filter((i) => i.keyword === keyword).flatMap((ins) => {
    const { pairs } = parsePairs(ins, state.sim.parsed.escape);
    return pairs.map((pair, index) => {
      const key = h('input', { class: 'key mono', value: pair.key, 'aria-label': `${keyword} ${t('ui.name')}` });
      const value = h('input', { class: 'mono', value: pair.value ?? '', placeholder: keyword === 'ARG' ? t('ui.noDefault') : '', 'aria-label': `${keyword} ${pair.key} ${t('ui.value')}` });
      const apply = () => edit((text) => ops.setPair(text, ins.startLine, index, {
        key: key.value,
        value: keyword === 'ARG' && value.value === '' && pair.value === null ? null : value.value,
      }));
      key.addEventListener('change', apply);
      value.addEventListener('change', apply);
      return h('div', { class: 'row' }, h('span', { class: 'badge' }, keyword), key, value,
        h('button', { class: 'danger', title: t('ui.delete'), onclick: () => edit((text) => ops.setPair(text, ins.startLine, index, null)) }, '×'));
    });
  });
}

function instructionRows(instructions) {
  return instructions.filter((i) => ['USER', 'WORKDIR', 'EXPOSE', 'CMD', 'ENTRYPOINT'].includes(i.keyword)).map((ins) => {
    const input = h('input', { class: 'mono', value: ins.args, 'aria-label': `${ins.keyword} ${t('ui.value')}` });
    input.addEventListener('change', () => edit((text) => ops.replaceInstruction(text, ins.startLine, ops.buildLine(ins.keyword, input.value))));
    return h('div', { class: 'row' }, h('span', { class: 'badge' }, ins.keyword), input,
      h('button', { class: 'danger', title: t('ui.delete'), onclick: () => edit((text) => ops.removeInstruction(text, ins.startLine)) }, '×'));
  });
}

const PAIR_HINTS = { ARG: ['ui.name', 'ui.defaultValue'], ENV: ['ui.name', 'ui.value'], LABEL: ['ui.name', 'ui.value'] };
const HINTS = {
  USER: ['app | 1000:1000'], WORKDIR: ['/app'], EXPOSE: ['8080/tcp'],
  RUN: ['apt-get update && apt-get install -y curl'], COPY: ['--chown=app:app . .'],
  CMD: ['["node", "server.js"]'], ENTRYPOINT: ['["/app"]'],
};
const addChoice = {};

function addForm(stageIndex, keywords) {
  const select = h('select', { 'aria-label': t('ui.add') }, keywords.map((k) => h('option', {}, k)));
  select.value = addChoice[stageIndex] ?? keywords[0];
  const fields = h('div', { class: 'row grow' });
  const build = () => {
    addChoice[stageIndex] = select.value;
    const paired = Object.hasOwn(PAIR_HINTS, select.value);
    const hints = paired ? PAIR_HINTS[select.value].map((k) => t(k)) : HINTS[select.value];
    fields.replaceChildren(...hints.map((hint, i) => h('input', { class: paired && i === 0 ? 'key mono' : 'mono', placeholder: hint, 'aria-label': `${select.value} ${hint}` })));
  };
  select.addEventListener('change', build);
  build();
  return h('form', {
    class: 'row',
    onsubmit: (e) => {
      e.preventDefault();
      const [a, b] = [...fields.children].map((c) => c.value);
      const keyword = select.value;
      if (!a.trim()) { toast(t('ui.enterValue')); return; }
      edit((text) => ops.addInstruction(text, stageIndex, ['ARG', 'ENV', 'LABEL'].includes(keyword)
        ? ops.buildPairLine(keyword, a, keyword === 'ARG' && b === '' ? null : b)
        : ops.buildLine(keyword, a)));
    },
  }, select, fields, h('button', { type: 'submit' }, t('ui.add')));
}

function splitForm(stage) {
  const raw = state.sim.rawStages[stage.index];
  if (!raw.instructions.length) return null;
  const at = h('select', { class: 'grow', 'aria-label': t('ui.splitTitle') },
    raw.instructions.map((i) => h('option', { value: i.startLine }, `${i.startLine}: ${i.keyword} ${i.args}`.slice(0, 60))));
  const name = h('input', { placeholder: t('ui.newName'), 'aria-label': t('ui.newName') });
  const base = h('input', { placeholder: t('ui.newBase'), 'aria-label': t('ui.newBase') });
  const path = h('input', { placeholder: t('ui.copyPath'), 'aria-label': t('ui.copyPath') });
  return h('details', {},
    h('summary', {}, t('ui.splitTitle')),
    h('div', { class: 'row' }, at),
    h('div', { class: 'row' }, name, base),
    h('div', { class: 'row' }, path, h('button', {
      onclick: () => edit((text) => ops.splitStage(text, Number(at.value), { name: name.value.trim(), base: base.value.trim(), copyPath: path.value.trim() })),
    }, t('ui.split'))));
}

function renderLeft() {
  const { sim } = state;
  const open = new Set([...$('left').querySelectorAll('details[open]')].map((d) => d.parentElement.dataset.stage));
  const cards = [
    h('div', { class: 'card' },
      h('h2', {}, t('ui.globalArgs')),
      pairRows(sim.globals, 'ARG'),
      addForm(-1, ['ARG'])),
  ];

  for (const stage of sim.stages) {
    const raw = sim.rawStages[stage.index];
    const selected = stage.index === sim.targetIndex;
    const image = h('input', { class: 'mono', value: raw.image, 'aria-label': `FROM ${stage.index}` });
    const name = h('input', { class: 'key mono', value: raw.name ?? '', placeholder: t('ui.name'), 'aria-label': `AS ${stage.index}` });
    image.addEventListener('change', () => edit((text) => ops.setStageFrom(text, stage.index, { image: image.value })));
    name.addEventListener('change', () => edit((text) => ops.setStageFrom(text, stage.index, { name: name.value })));
    const card = h('div', { class: `card${selected ? ' selected' : ''}${sim.used.has(stage.index) ? '' : ' unused'}` },
      h('div', { class: 'head' },
        h('h2', { class: 'clickable', onclick: () => goToLine(raw.from.startLine) }, t('ui.stage', { n: stage.index })),
        selected ? h('span', { class: 'badge accent' }, t('ui.target')) : h('button', { class: 'link', onclick: () => { state.selected = stage.index; refresh(); } }, t('ui.showResult')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'link', onclick: () => exportStage(stage.index) }, t('ui.export')),
        h('button', {
          class: 'link danger',
          onclick: () => {
            if (confirm(t('ui.confirmDelete', { name: stage.name ?? stage.index }))) { state.selected = null; edit((text) => ops.removeStage(text, stage.index)); }
          },
        }, t('ui.delete'))),
      h('div', { class: 'row' }, h('span', { class: 'badge' }, 'FROM'), image, h('span', { class: 'muted' }, 'AS'), name),
      imageStatus(stage),
      pairRows(raw.instructions, 'ARG'),
      pairRows(raw.instructions, 'ENV'),
      pairRows(raw.instructions, 'LABEL'),
      instructionRows(raw.instructions),
      addForm(stage.index, ['ENV', 'ARG', 'USER', 'WORKDIR', 'EXPOSE', 'LABEL', 'RUN', 'COPY', 'CMD', 'ENTRYPOINT']),
      splitForm(stage));
    card.dataset.stage = String(stage.index);
    if (open.has(card.dataset.stage)) card.querySelector('details')?.setAttribute('open', '');
    cards.push(card);
  }

  const newImage = h('input', { class: 'mono', placeholder: t('ui.image'), 'aria-label': t('ui.image') });
  const newName = h('input', { class: 'key mono', placeholder: t('ui.name'), 'aria-label': t('ui.addStage') });
  cards.push(h('div', { class: 'card' }, h('h2', {}, t('ui.addStage')),
    h('div', { class: 'row' }, newImage, newName, h('button', {
      onclick: () => { state.selected = null; edit((text) => ops.addStage(text, { image: newImage.value, name: newName.value.trim() })); },
    }, t('ui.add')))));
  $('left').replaceChildren(...cards);
}

// ---------- right: result and compatibility ----------
const label = (s) => s.name ?? `#${s.index}`;
const table = (rows) => h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v)))));
const list = (items, empty) => (items.length ? items.map((v) => h('div', {}, v)) : h('span', { class: 'muted' }, empty));

function renderFlow() {
  const { sim } = state;
  return h('div', { class: 'card' }, h('h2', {}, t('ui.flow')),
    h('div', { class: 'flow' }, sim.stages.flatMap((s) => {
      const incoming = [];
      if (s.parentIndex !== null) incoming.push(`↓ FROM ${label(sim.stages[s.parentIndex])}`);
      for (const dep of s.deps.filter((d) => d !== s.parentIndex)) incoming.push(t('ui.copiesFrom', { name: label(sim.stages[dep]) }));
      for (const ext of s.externalFrom) incoming.push(t('ui.external', { name: ext }));
      return [
        h('div', { class: 'edge' }, incoming.map((line) => h('div', {}, line))),
        h('button', {
          class: `node${s.index === sim.targetIndex ? ' target' : ''}${sim.used.has(s.index) ? '' : ' unused'}`,
          onclick: () => { state.selected = s.index; refresh(); },
        }, h('strong', {}, label(s)), ' ', h('span', { class: 'muted mono' }, s.baseRef),
        sim.used.has(s.index) ? null : h('span', { class: 'muted' }, ` ${t('ui.skipped')}`)),
      ];
    })));
}

function buildArgsCard() {
  const { sim } = state;
  const args = new Map();
  for (const ins of sim.parsed.instructions.filter((i) => i.keyword === 'ARG')) {
    for (const p of parsePairs(ins, sim.parsed.escape).pairs) if (!args.has(p.key) || args.get(p.key) === null) args.set(p.key, p.value);
  }
  if (!args.size) return null;
  return h('div', { class: 'card' }, h('h2', {}, t('ui.tryArgs')),
    [...args].map(([key, def]) => {
      const input = h('input', { class: 'mono', value: state.buildArgs[key] ?? '', placeholder: def ?? t('ui.noValue'), 'aria-label': `build-arg ${key}` });
      input.addEventListener('change', () => {
        if (input.value === '') delete state.buildArgs[key];
        else state.buildArgs[key] = input.value;
        refresh();
      });
      return h('div', { class: 'row' }, h('span', { class: 'mono grow' }, key), input);
    }));
}

function renderPreview() {
  const { sim } = state;
  const final = sim.stages[sim.targetIndex];
  if (!final) {
    $('preview').replaceChildren(h('div', { class: 'card muted' }, t('ui.noStage')));
    return;
  }
  const s = final.state;
  const windows = final.os === 'windows';
  const unknown = final.baseKnown ? t('ui.none') : t('ui.fromBase');
  const command = effectiveCommand(s, final.os);
  const errors = state.diagnostics.filter((d) => d.severity === 'error').length;
  const from = (f) => f.origin.name ?? t('ui.buildContext');

  $('preview').replaceChildren(...[
    errors ? h('div', { class: 'card text-error' }, t('ui.hasErrors', { n: errors })) : null,
    renderFlow(),
    h('div', { class: 'card' },
      h('h2', {}, t('ui.finalImage', { name: label(final) })),
      h('div', { class: 'muted' }, t('ui.baseSummary', { ref: final.baseRef, used: sim.used.size, total: sim.stages.length })),
      h('h3', {}, t('ui.process')),
      h('pre', { class: 'block mono' }, command.length ? JSON.stringify(command) : unknown),
      table([
        ['USER', s.user ?? (final.baseKnown && !windows ? t('ui.defaultUser', { user: 'root' }) : unknown)],
        ['WORKDIR', s.workdir ?? (final.baseKnown && !windows ? '/' : unknown)],
        ['EXPOSE', list([...s.expose], unknown)],
        ['VOLUME', list([...s.volumes], t('ui.none'))],
        ['HEALTHCHECK', s.healthcheck ?? t('ui.none')],
        ['STOPSIGNAL', s.stopsignal ?? 'SIGTERM'],
      ]),
      h('h3', {}, t('ui.envTitle')),
      s.env.size ? table([...s.env]) : h('span', { class: 'muted' }, unknown),
      s.args.size ? [h('h3', {}, t('ui.argTitle')), table([...s.args].map(([k, v]) => [k, v ?? t('ui.noValue')]))] : null,
      s.labels.size ? [h('h3', {}, 'LABEL'), table([...s.labels])] : null),
    h('div', { class: 'card' },
      h('h2', {}, t('ui.files')),
      s.files.length ? table(s.files.map((f) => [f.dest, `${f.src}  ← ${from(f)}${f.chown ? ` · chown ${f.chown}` : ''}${f.chmod ? ` · chmod ${f.chmod}` : ''}`])) : h('span', { class: 'muted' }, t('ui.noCopy')),
      h('h3', {}, t('ui.layers', { n: s.layers.length })),
      h('ol', { class: 'layers' }, s.layers.map((l) => h('li', { class: 'clickable', onclick: () => goToLine(l.line) },
        h('span', { class: 'badge' }, l.keyword), ' ', h('span', { class: 'mono' }, l.summary.slice(0, 160)))))),
    buildArgsCard(),
    h('div', { class: 'muted' }, t('ui.previewNote')),
  ].filter(Boolean));
}

function renderCompat() {
  const { sim } = state;
  // Any earlier result for an image carries its published platform list.
  const lookup = (ref) => Object.entries(state.imageResults).find(([key, r]) => key.startsWith(`${ref}|`) && r.status !== 'checking')?.[1];
  const compat = compatibility(sim, lookup);
  const cell = (v) => h('td', { class: v === true ? 'text-ok' : v === false ? 'text-error' : 'muted' }, v === true ? '✓' : v === false ? '✗' : '?');
  const head = h('tr', {}, h('th', {}), compat.platforms.map((p) => h('th', {}, p.replace('/', '\n'))));
  $('compat').replaceChildren(
    h('div', { class: 'card' }, h('h2', {}, t('ui.compatTitle')),
      h('table', { class: 'matrix' }, h('thead', {}, head), h('tbody', {},
        compat.rows.map((row) => h('tr', {},
          h('th', {}, h('div', {}, row.name ?? `#${row.index}`), h('div', { class: 'muted mono' }, row.ref),
            row.pinned ? h('div', { class: 'badge' }, t('ui.pinned', { platform: row.pinned })) : null),
          row.cells.map(cell))),
        h('tr', { class: 'total' }, h('th', {}, t('ui.compatAll')), compat.summary.map(cell)))),
      h('div', { class: 'muted' }, t('ui.compatLegend')),
      h('button', { class: 'primary', onclick: checkImages }, t('ui.check'))),
    h('div', { class: 'muted' }, t('ui.compatNote')));
}

function showTab(name) {
  state.tab = name;
  for (const button of $('tabs').children) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
    $(button.dataset.tab).hidden = button.dataset.tab !== name;
  }
  if (name === 'build') buildPanel.update();
}

function render() {
  if (!state.sim) return;
  renderEditor();
  renderDiagnostics();
  renderLeft();
  renderPreview();
  renderCompat();
  if (state.tab === 'build') buildPanel.update();
  $('undo').disabled = !state.history.length;
  $('redo').disabled = !state.future.length;
}

// ---------- files ----------
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const save = () => download($('filename').value || 'Dockerfile', source.value);
function exportStage(index) {
  try {
    const stage = state.sim.stages[index];
    download(`${$('filename').value || 'Dockerfile'}.${stage.name ?? index}`, ops.extractStage(source.value, index));
  } catch (e) {
    console.warn('[EXPORT] failed:', e);
    toast(e.key ? t(e.key, e.params) : e.message);
  }
}

async function openFile(file) {
  if (!file) return;
  if (file.size > 512 * 1024) { toast(t('ui.tooBig')); return; }
  try {
    const text = await file.text();
    $('filename').value = file.name;
    state.buildArgs = {};
    state.selected = null;
    setText(text.replace(/\r\n?/g, '\n'));
    toast(t('ui.opened', { name: file.name }));
  } catch (e) {
    console.error('[OPEN] failed:', file.name, e);
    toast(t('ui.readFailed'));
  }
}

// ---------- language ----------
function applyLanguage(next) {
  lang = normalizeLang(next);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.title = t('ui.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  $('template').replaceChildren(h('option', { value: '' }, t('ui.new')),
    ...Object.keys(TEMPLATES).map((name) => h('option', { value: name }, t(`template.${name}`))));
  $('language').value = lang;
  buildPanel.relabel();
}

const buildPanel = createBuildPanel({
  root: $('build'), h, t, toast,
  current: () => ({
    content: source.value, platform: $('platform').value, filename: $('filename').value || 'Dockerfile',
    buildArgs: state.buildArgs,
    // An unnamed stage cannot be a --target; "#n" makes the builder say so instead of building the last stage.
    target: state.sim && state.sim.targetIndex !== state.sim.stages.length - 1 ? state.sim.stages[state.sim.targetIndex]?.name ?? `#${state.sim.targetIndex}` : '',
  }),
});

// ---------- events and start ----------
$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('save').addEventListener('click', save);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('check').addEventListener('click', () => { checkImages(); showTab('compat'); });
$('platform').addEventListener('change', refresh);
$('filename').addEventListener('change', refresh);
for (const button of $('tabs').children) button.addEventListener('click', () => showTab(button.dataset.tab));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});

$('template').addEventListener('change', (e) => {
  const name = e.target.value;
  e.target.value = '';
  if (!Object.hasOwn(TEMPLATES, name)) return;
  state.buildArgs = {};
  state.selected = null;
  if (name === 'windows') $('platform').value = 'windows/amd64';
  else if ($('platform').value.startsWith('windows/')) $('platform').value = 'linux/amd64';
  setText(TEMPLATES[name]);
  toast(t('ui.templated'));
});

for (const [code, name] of Object.entries(LANGUAGES)) $('language').append(h('option', { value: code }, name));
$('language').addEventListener('change', (e) => {
  applyLanguage(e.target.value);
  try {
    localStorage.setItem(`${STORE}.lang`, lang);
  } catch (err) {
    console.warn('[STORE] language not saved:', err);
  }
  refresh();
});

let saved = null;
let savedLang = null;
try {
  saved = JSON.parse(localStorage.getItem(STORE));
  savedLang = localStorage.getItem(`${STORE}.lang`);
} catch (e) {
  console.warn('[STORE] could not read saved content:', e);
}
source.value = saved?.text ?? TEMPLATES.node;
$('filename').value = saved?.name ?? 'Dockerfile';
lastSaved = source.value;
// English is the default; ?lang= or an earlier choice overrides it.
applyLanguage(new URLSearchParams(location.search).get('lang') ?? savedLang ?? 'en');
showTab('preview');
refresh();
