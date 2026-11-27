import { INSTRUCTIONS, parsePairs } from './core/parser.js';
import { simulate, effectiveCommand } from './core/simulator.js';
import { validate } from './core/validator.js';
import * as ops from './core/editor-ops.js';
import { TEMPLATES } from './core/templates.js';

const $ = (id) => document.getElementById(id);
const source = $('source');
const STORE = 'dockereditor.v1';

const state = {
  buildArgs: {},
  imageResults: {}, // `${ref}|${platform}` -> 서버 응답 또는 {status:'checking'}
  selected: null, // 선택한 스테이지(=빌드 대상). null 이면 마지막
  history: [],
  future: [],
  sim: null,
  diagnostics: [],
};

// ---------- DOM 도우미 ----------
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

// ---------- 문서 변경 ----------
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

// 패널에서의 편집. 실패하면 이유를 알려준다.
function edit(fn) {
  try {
    setText(fn(source.value));
  } catch (e) {
    console.warn('[EDIT] 편집 실패:', e);
    toast(e.message);
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

// ---------- FROM 확인 ----------
const platformOf = (stage) => (stage.platform && !stage.platform.includes('$') ? stage.platform : $('platform').value);
const imageKey = (stage) => `${stage.baseRef}|${platformOf(stage)}`;

function externalStages(sim) {
  return sim.stages.filter((s) => s.parentIndex === null && s.baseRef && s.baseRef !== 'scratch' && !s.baseRef.includes('$'));
}

async function checkImages() {
  const targets = new Map(externalStages(state.sim).map((s) => [imageKey(s), s]));
  if (!targets.size) { toast('확인할 외부 이미지가 없습니다.'); return; }
  $('check').disabled = true;
  for (const key of targets.keys()) state.imageResults[key] = { status: 'checking' };
  refresh();
  await Promise.all([...targets].map(async ([key, stage]) => {
    try {
      const query = new URLSearchParams({ ref: stage.baseRef, platform: platformOf(stage) });
      const res = await fetch(`/api/check-image?${query}`);
      const body = await res.json();
      state.imageResults[key] = body.status ? body : { status: 'error', message: `서버 응답 HTTP ${res.status}` };
    } catch (e) {
      console.error('[CHECK] 이미지 확인 실패:', stage.baseRef, e);
      state.imageResults[key] = { status: 'error', message: '로컬 서버에 연결할 수 없습니다.' };
    }
  }));
  $('check').disabled = false;
  refresh();
}

// ---------- 분석 ----------
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
  state.diagnostics = validate(text, { sim: state.sim });

  for (const stage of externalStages(state.sim)) {
    const result = state.imageResults[imageKey(stage)];
    const line = state.sim.rawStages[stage.index].from.startLine;
    if (result?.status === 'not_found') state.diagnostics.push({ severity: 'error', line, message: `이미지를 찾을 수 없습니다: ${stage.baseRef}` });
    else if (result?.status === 'auth_required' || result?.status === 'invalid') state.diagnostics.push({ severity: 'warning', line, message: `${stage.baseRef}: ${result.message}` });
    else if (result?.platformMissing) state.diagnostics.push({ severity: 'error', line, message: `${stage.baseRef} 에는 ${platformOf(stage)} 용 이미지가 없습니다.` });
  }
  state.diagnostics.sort((a, b) => a.line - b.line);
}

function refresh() {
  try {
    analyze();
  } catch (e) {
    console.error('[ANALYZE] 분석 실패:', e);
    toast(`분석 중 오류: ${e.message}`);
  }
  render();
  try {
    localStorage.setItem(STORE, JSON.stringify({ text: source.value, name: $('filename').value }));
  } catch (e) {
    console.warn('[STORE] 자동 저장 실패:', e);
  }
}

// ---------- 편집기 표시 ----------
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
  // 마지막 여백 줄은 스크롤 위치를 textarea 와 맞추기 위한 것
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
    h('span', { class: errors ? 'text-error' : 'text-ok' }, errors ? `오류 ${errors}` : '문법 오류 없음'),
    ` · 경고 ${count('warning')} · 제안 ${count('info')}`,
  );
  const label = { error: '오류', warning: '경고', info: '제안' };
  $('diagnostics').replaceChildren(...state.diagnostics.map((d) => h('li', {},
    h('button', { class: d.severity, onclick: () => goToLine(d.line) },
      h('span', { class: 'tag' }, label[d.severity]),
      h('span', { class: 'muted' }, `${d.line}줄`),
      h('span', {}, d.message)))));
}

// ---------- 왼쪽: 스테이지와 설정 ----------
function imageStatus(stage) {
  if (stage.parentIndex !== null) return h('div', { class: 'image-status muted' }, `↳ 앞 스테이지에서 이어받음`);
  if (stage.baseRef === 'scratch') return h('div', { class: 'image-status muted' }, '빈 이미지(scratch)');
  const r = state.imageResults[imageKey(stage)];
  if (!r) return h('div', { class: 'image-status muted' }, `${stage.baseRef} — 아직 확인 안 함`);
  if (r.status === 'checking') return h('div', { class: 'image-status muted' }, '확인 중…');
  if (r.status === 'exists') {
    if (r.platformMissing) return h('div', { class: 'image-status text-error' }, `✗ 태그는 있지만 ${platformOf(stage)} 가 없습니다. 지원: ${r.platforms?.join(', ')}`);
    const size = r.compressedSize ? ` · 압축 ${(r.compressedSize / 1048576).toFixed(1)} MB` : '';
    return h('div', { class: 'image-status text-ok', title: r.digest ?? '' },
      `✓ ${stage.baseRef} 존재함${size}${r.configError ? ` (설정 읽기 실패: ${r.configError})` : ''}`);
  }
  const cls = r.status === 'not_found' || r.status === 'invalid' ? 'text-error' : 'text-warning';
  const mark = r.status === 'not_found' || r.status === 'invalid' ? '✗' : '?';
  return h('div', { class: `image-status ${cls}` }, `${mark} ${r.message}`,
    r.suggestions?.length ? h('div', { class: 'muted' }, '비슷한 태그: ', r.suggestions.map((tag) => h('button', {
      class: 'link',
      onclick: () => {
        const image = state.sim.rawStages[stage.index].image;
        const name = image.split('@')[0];
        const repo = name.lastIndexOf(':') > name.lastIndexOf('/') ? name.slice(0, name.lastIndexOf(':')) : name;
        if (repo.includes('$')) toast('변수를 쓰는 FROM 은 ARG 값을 고쳐 주세요.');
        else edit((t) => ops.setStageFrom(t, stage.index, { image: `${repo}:${tag}` }));
      },
    }, `${tag} `))) : null);
}

function pairRows(instructions, keyword) {
  return instructions.filter((i) => i.keyword === keyword).flatMap((ins) => {
    const { pairs } = parsePairs(ins, state.sim.parsed.escape);
    return pairs.map((pair, index) => {
      const key = h('input', { class: 'key mono', value: pair.key, 'aria-label': `${keyword} 이름` });
      const value = h('input', { class: 'mono', value: pair.value ?? '', placeholder: keyword === 'ARG' ? '(기본값 없음)' : '', 'aria-label': `${keyword} ${pair.key} 값` });
      const apply = () => edit((t) => ops.setPair(t, ins.startLine, index, {
        key: key.value,
        value: keyword === 'ARG' && value.value === '' && pair.value === null ? null : value.value,
      }));
      key.addEventListener('change', apply);
      value.addEventListener('change', apply);
      return h('div', { class: 'row' }, h('span', { class: 'badge' }, keyword), key, value,
        h('button', { class: 'danger', title: '삭제', onclick: () => edit((t) => ops.setPair(t, ins.startLine, index, null)) }, '×'));
    });
  });
}

function instructionRows(instructions) {
  return instructions.filter((i) => ['USER', 'WORKDIR', 'EXPOSE', 'CMD', 'ENTRYPOINT'].includes(i.keyword)).map((ins) => {
    const input = h('input', { class: 'mono', value: ins.args, 'aria-label': `${ins.keyword} 값` });
    input.addEventListener('change', () => edit((t) => ops.replaceInstruction(t, ins.startLine, ops.buildLine(ins.keyword, input.value))));
    return h('div', { class: 'row' }, h('span', { class: 'badge' }, ins.keyword), input,
      h('button', { class: 'danger', title: '삭제', onclick: () => edit((t) => ops.removeInstruction(t, ins.startLine)) }, '×'));
  });
}

const HINTS = {
  ARG: ['이름', '기본값(선택)'], ENV: ['이름', '값'], LABEL: ['키', '값'],
  USER: ['app 또는 1000:1000'], WORKDIR: ['/app'], EXPOSE: ['8080/tcp'],
  RUN: ['apt-get update && apt-get install -y curl'], COPY: ['--chown=app:app . .'],
  CMD: ['["node", "server.js"]'], ENTRYPOINT: ['["/app"]'],
};
const addChoice = {};

function addForm(stageIndex, keywords) {
  const select = h('select', { 'aria-label': '추가할 지시어' }, keywords.map((k) => h('option', {}, k)));
  select.value = addChoice[stageIndex] ?? keywords[0];
  const fields = h('div', { class: 'row grow' });
  const build = () => {
    addChoice[stageIndex] = select.value;
    const paired = ['ARG', 'ENV', 'LABEL'].includes(select.value);
    fields.replaceChildren(...HINTS[select.value].map((hint, i) => h('input', { class: paired && i === 0 ? 'key mono' : 'mono', placeholder: hint, 'aria-label': `새 ${select.value} ${hint}` })));
  };
  select.addEventListener('change', build);
  build();
  return h('form', {
    class: 'row',
    onsubmit: (e) => {
      e.preventDefault();
      const [a, b] = [...fields.children].map((c) => c.value);
      const keyword = select.value;
      if (!a.trim()) { toast('값을 입력하세요.'); return; }
      edit((t) => ops.addInstruction(t, stageIndex, ['ARG', 'ENV', 'LABEL'].includes(keyword)
        ? ops.buildPairLine(keyword, a, keyword === 'ARG' && b === '' ? null : b)
        : ops.buildLine(keyword, a)));
    },
  }, select, fields, h('button', { type: 'submit' }, '추가'));
}

function splitForm(stage) {
  const raw = state.sim.rawStages[stage.index];
  if (!raw.instructions.length) return null;
  const at = h('select', { class: 'grow', 'aria-label': '분리 시작 지점' },
    raw.instructions.map((i) => h('option', { value: i.startLine }, `${i.startLine}줄 ${i.keyword} ${i.args}`.slice(0, 60))));
  const name = h('input', { placeholder: '새 이름 (예: runtime)', 'aria-label': '새 스테이지 이름' });
  const base = h('input', { placeholder: '새 베이스 (비우면 이어받기)', 'aria-label': '새 베이스 이미지' });
  const path = h('input', { placeholder: '가져올 경로 (예: /app)', 'aria-label': '이전 스테이지에서 복사할 경로' });
  return h('details', {},
    h('summary', {}, '여기서 스테이지 분리'),
    h('div', { class: 'row' }, at),
    h('div', { class: 'row' }, name, base),
    h('div', { class: 'row' }, path, h('button', {
      onclick: () => edit((t) => ops.splitStage(t, Number(at.value), { name: name.value.trim(), base: base.value.trim(), copyPath: path.value.trim() })),
    }, '분리')));
}

function renderLeft() {
  const { sim } = state;
  const open = new Set([...$('left').querySelectorAll('details[open]')].map((d) => d.parentElement.dataset.stage));
  const cards = [
    h('div', { class: 'card' },
      h('h2', {}, '전역 ARG ', h('span', { class: 'muted' }, '(첫 FROM 앞)')),
      pairRows(sim.globals, 'ARG'),
      addForm(-1, ['ARG'])),
  ];

  for (const stage of sim.stages) {
    const raw = sim.rawStages[stage.index];
    const selected = stage.index === sim.targetIndex;
    const image = h('input', { class: 'mono', value: raw.image, 'aria-label': `스테이지 ${stage.index} 이미지` });
    const name = h('input', { class: 'key mono', value: raw.name ?? '', placeholder: '이름', 'aria-label': `스테이지 ${stage.index} 이름` });
    image.addEventListener('change', () => edit((t) => ops.setStageFrom(t, stage.index, { image: image.value })));
    name.addEventListener('change', () => edit((t) => ops.setStageFrom(t, stage.index, { name: name.value })));
    const card = h('div', { class: `card${selected ? ' selected' : ''}${sim.used.has(stage.index) ? '' : ' unused'}` },
      h('div', { class: 'head' },
        h('h2', { class: 'clickable', onclick: () => goToLine(raw.from.startLine) }, `스테이지 ${stage.index}`),
        selected ? h('span', { class: 'badge accent' }, '빌드 대상') : h('button', { class: 'link', onclick: () => { state.selected = stage.index; refresh(); } }, '결과 보기'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'link', title: '이 스테이지를 빌드하는 데 필요한 부분만 파일로 저장', onclick: () => exportStage(stage.index) }, '따로 저장'),
        h('button', {
          class: 'link danger',
          onclick: () => {
            if (confirm(`스테이지 ${stage.name ?? stage.index} 를 삭제할까요? (되돌리기 가능)`)) { state.selected = null; edit((t) => ops.removeStage(t, stage.index)); }
          },
        }, '삭제')),
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

  const newImage = h('input', { class: 'mono', placeholder: '이미지 (예: alpine:3.20)', 'aria-label': '새 스테이지 이미지' });
  const newName = h('input', { class: 'key mono', placeholder: '이름', 'aria-label': '새 스테이지 이름' });
  cards.push(h('div', { class: 'card' }, h('h2', {}, '스테이지 추가'),
    h('div', { class: 'row' }, newImage, newName, h('button', {
      onclick: () => { state.selected = null; edit((t) => ops.addStage(t, { image: newImage.value, name: newName.value.trim() })); },
    }, '추가'))));
  $('left').replaceChildren(...cards);
}

// ---------- 오른쪽: 결과 ----------
const label = (s) => s.name ?? `#${s.index}`;
const table = (rows) => h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v)))));
const list = (items, empty = '없음') => (items.length ? items.map((v) => h('div', {}, v)) : h('span', { class: 'muted' }, empty));

function renderFlow() {
  const { sim } = state;
  return h('div', { class: 'card' }, h('h2', {}, '스테이지 흐름'),
    h('div', { class: 'flow' }, sim.stages.flatMap((s) => {
      const incoming = [];
      if (s.parentIndex !== null) incoming.push(`↓ FROM ${label(sim.stages[s.parentIndex])}`);
      for (const dep of s.deps.filter((d) => d !== s.parentIndex)) incoming.push(`↓ 파일 가져옴: ${label(sim.stages[dep])}`);
      for (const ext of s.externalFrom) incoming.push(`↓ 외부 이미지에서 가져옴: ${ext}`);
      return [
        h('div', { class: 'edge' }, incoming.map((t) => h('div', {}, t))),
        h('button', {
          class: `node${s.index === sim.targetIndex ? ' target' : ''}${sim.used.has(s.index) ? '' : ' unused'}`,
          onclick: () => { state.selected = s.index; refresh(); },
        }, h('strong', {}, label(s)), ' ', h('span', { class: 'muted mono' }, s.baseRef),
        sim.used.has(s.index) ? null : h('span', { class: 'muted' }, ' (빌드에서 제외)')),
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
  return h('div', { class: 'card' }, h('h2', {}, '--build-arg 시험 ', h('span', { class: 'muted' }, '(파일은 바뀌지 않음)')),
    [...args].map(([key, def]) => {
      const input = h('input', { class: 'mono', value: state.buildArgs[key] ?? '', placeholder: def ?? '(값 없음)', 'aria-label': `build-arg ${key}` });
      input.addEventListener('change', () => {
        if (input.value === '') delete state.buildArgs[key];
        else state.buildArgs[key] = input.value;
        refresh();
      });
      return h('div', { class: 'row' }, h('span', { class: 'mono grow' }, key), input);
    }));
}

function renderRight() {
  const { sim } = state;
  const final = sim.stages[sim.targetIndex];
  if (!final) {
    $('right').replaceChildren(h('div', { class: 'card muted' }, 'FROM 을 추가하면 결과가 보입니다.'));
    return;
  }
  const s = final.state;
  const unknown = final.baseKnown ? '없음' : '베이스 이미지 값 (FROM 확인 필요)';
  const command = effectiveCommand(s);
  const quote = (v) => (/^[\w./:=@-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);
  const used = [...sim.used];
  const buildCommand = [
    'docker build', `-f ${quote($('filename').value || 'Dockerfile')}`,
    sim.targetIndex !== sim.stages.length - 1 && final.name ? `--target ${final.name}` : null,
    `--platform ${$('platform').value}`,
    ...Object.entries(state.buildArgs).map(([k, v]) => `--build-arg ${quote(`${k}=${v}`)}`),
    '-t myimage .',
  ].filter(Boolean).join(' ');
  const errors = state.diagnostics.filter((d) => d.severity === 'error').length;

  $('right').replaceChildren(...[
    errors ? h('div', { class: 'card text-error' }, `오류 ${errors}개가 있어 실제 빌드는 실패할 수 있습니다. 아래는 해석 가능한 범위의 결과입니다.`) : null,
    renderFlow(),
    h('div', { class: 'card' },
      h('h2', {}, `최종 이미지 — ${label(final)}`),
      h('div', { class: 'muted' }, `베이스: ${final.baseRef} · 빌드되는 스테이지 ${used.length}/${sim.stages.length}`),
      h('h3', {}, 'docker run 하면 실행되는 프로세스'),
      h('pre', { class: 'block mono' }, command.length ? JSON.stringify(command) : unknown),
      table([
        ['USER', s.user ?? (final.baseKnown ? 'root (기본)' : unknown)],
        ['WORKDIR', s.workdir ?? (final.baseKnown ? '/' : unknown)],
        ['EXPOSE', list([...s.expose], unknown)],
        ['VOLUME', list([...s.volumes])],
        ['HEALTHCHECK', s.healthcheck ?? '없음'],
        ['STOPSIGNAL', s.stopsignal ?? '기본(SIGTERM)'],
      ]),
      h('h3', {}, '환경 변수 (컨테이너에 남음)'),
      s.env.size ? table([...s.env]) : h('span', { class: 'muted' }, unknown),
      s.args.size ? [h('h3', {}, 'ARG (빌드 중에만)'), table([...s.args].map(([k, v]) => [k, v ?? '(값 없음)']))] : null,
      s.labels.size ? [h('h3', {}, 'LABEL'), table([...s.labels])] : null),
    h('div', { class: 'card' },
      h('h2', {}, '이미지에 들어가는 파일'),
      s.files.length ? table(s.files.map((f) => [f.dest, `${f.src}  ← ${f.origin}${f.chown ? ` · 소유자 ${f.chown}` : ''}${f.chmod ? ` · 권한 ${f.chmod}` : ''}`])) : h('span', { class: 'muted' }, 'COPY/ADD 없음'),
      h('h3', {}, `추가되는 레이어 (베이스 위, ${s.layers.length}개)`),
      h('ol', { class: 'layers' }, s.layers.map((l) => h('li', { class: 'clickable', onclick: () => goToLine(l.line) },
        h('span', { class: 'badge' }, l.keyword), ' ', h('span', { class: 'mono' }, l.summary.slice(0, 160)))))),
    buildArgsCard(),
    h('div', { class: 'card' }, h('h2', {}, '빌드 명령'), h('pre', { class: 'block mono' }, buildCommand),
      h('button', { onclick: () => navigator.clipboard.writeText(buildCommand).then(() => toast('복사했습니다.'), () => toast('복사할 수 없습니다.')) }, '복사')),
    h('div', { class: 'muted' }, '이 미리보기는 파일을 해석한 결과이며 실제 빌드를 실행하지 않습니다. RUN 명령이 만드는 파일과 사용자는 반영되지 않습니다.'),
  ].filter(Boolean));
}

function render() {
  if (!state.sim) return;
  renderEditor();
  renderDiagnostics();
  renderLeft();
  renderRight();
  $('undo').disabled = !state.history.length;
  $('redo').disabled = !state.future.length;
}

// ---------- 파일 ----------
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
    console.warn('[EXPORT] 스테이지 저장 실패:', e);
    toast(e.message);
  }
}

async function openFile(file) {
  if (!file) return;
  if (file.size > 512 * 1024) { toast('512KB 를 넘는 파일은 열 수 없습니다.'); return; }
  try {
    const text = await file.text();
    $('filename').value = file.name;
    state.buildArgs = {};
    state.selected = null;
    setText(text.replace(/\r\n?/g, '\n'));
    toast(`${file.name} 을 열었습니다.`);
  } catch (e) {
    console.error('[OPEN] 파일 읽기 실패:', file.name, e);
    toast('파일을 읽을 수 없습니다.');
  }
}

$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('save').addEventListener('click', save);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('check').addEventListener('click', checkImages);
$('platform').addEventListener('change', refresh);
$('filename').addEventListener('change', refresh);
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});

for (const name of Object.keys(TEMPLATES)) $('template').append(h('option', { value: name }, name));
$('template').addEventListener('change', (e) => {
  const text = TEMPLATES[e.target.value];
  e.target.value = '';
  if (!text) return;
  state.buildArgs = {};
  state.selected = null;
  setText(text);
  toast('템플릿을 적용했습니다. 되돌리기로 이전 내용을 복구할 수 있습니다.');
});

let saved = null;
try {
  saved = JSON.parse(localStorage.getItem(STORE));
} catch (e) {
  console.warn('[STORE] 저장된 내용을 읽지 못했습니다:', e);
}
source.value = saved?.text ?? Object.values(TEMPLATES)[0];
$('filename').value = saved?.name ?? 'Dockerfile';
lastSaved = source.value;
refresh();
