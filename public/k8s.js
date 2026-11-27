import { createK8s, KINDS } from './core/k8s.js';
import { K8S_MESSAGES } from './core/k8s-i18n.js';
import { K8S_UI_MESSAGES } from './k8s-ui-i18n.js';
import { simulate } from './core/simulator.js';
import { LANGUAGES, translate, normalizeLang } from './core/i18n.js';

const $ = (id) => document.getElementById(id);
const source = $('source');
const STORE = 'containereditor.k8s.v1';
const DOCKER_STORE = 'containereditor.v1'; // written by the Dockerfile page
const LANG_STORE = 'containereditor.v1.lang';
const LINK_STORE = `${STORE}.link`;
const PLATFORM = 'linux/amd64';
const MAX_FILE = 512 * 1024;
// Errs on the side of "this is a Secret", also while the YAML does not parse.
const SECRET_KIND = /(^|[\s{,-])["']?kind["']?\s*:\s*(!!str\s+)?["']?Secret(List)?(?![\w-])/m;

let lang = 'en';
let k8s = null;

function t(key, params = {}) {
  const entry = K8S_UI_MESSAGES[key] ?? K8S_MESSAGES[key];
  if (!entry) return translate(lang, key, params);
  return entry[Object.keys(LANGUAGES).indexOf(lang)]
    .replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}
const errorText = (e) => (e.key ? t(e.key, e.params) : e.message);

const state = {
  selected: 0, // document index shown in the form
  docs: [],
  errors: [], // syntax errors from parse()
  diagnostics: [],
  images: [],
  imageResults: new Map(), // ref -> server response or {status:'checking'}
  linked: true,
  docker: null, // { name, final, image } of the saved Dockerfile
  history: [],
  future: [],
  secret: false,
  downloaded: null, // text of the last download or opened file
};

// ---------- DOM helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list' && k !== 'spellcheck') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

// Runs a core call that may fail on half-written YAML without breaking the page.
function safe(what, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[K8S] ${what} failed:`, e.key ?? e.message);
    return fallback;
  }
}

// ---------- document changes ----------
let lastSaved = '';
let typingAt = 0;

function remember(previous) {
  state.history.push(previous);
  if (state.history.length > 200) state.history.shift();
  state.future = [];
}

function setText(text) {
  if (text === source.value) return;
  remember(source.value);
  source.value = text;
  lastSaved = text;
  typingAt = 0;
  refresh();
}

// Edits from the panels; show why when one fails. Returns false on failure.
function edit(fn) {
  try {
    setText(fn(source.value));
    return true;
  } catch (e) {
    console.warn('[EDIT] failed:', e.key ?? e.message);
    toast(errorText(e));
    leftSignature = ''; // put the old value back into the form
    scheduleLeft();
    return false;
  }
}

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

// ---------- analysis ----------
function readDockerfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(DOCKER_STORE));
    if (!saved?.text?.trim()) return null;
    const sim = simulate(saved.text);
    const final = sim.stages[sim.targetIndex];
    if (!final) return null;
    const argv = (c) => (c === null ? null : c.form === 'shell' ? ['/bin/sh', '-c', c.value] : c.value);
    return {
      name: saved.name || 'Dockerfile',
      baseRef: final.baseRef,
      image: {
        expose: [...final.state.expose],
        user: final.state.user,
        entrypoint: argv(final.state.entrypoint),
        cmd: argv(final.state.cmd),
        known: final.baseKnown,
      },
    };
  } catch (e) {
    console.warn('[LINK] could not read the saved Dockerfile:', e.message);
    return null;
  }
}

function imageDiagnostics() {
  const out = [];
  for (const entry of state.images) {
    const r = state.imageResults.get(entry.ref);
    const at = { line: entry.line, doc: entry.doc, code: 'image' };
    if (r?.status === 'not_found') out.push({ ...at, severity: 'error', message: t('diag.imageNotFound', { ref: entry.ref }) });
    else if (['auth_required', 'invalid', 'blocked'].includes(r?.status)) out.push({ ...at, severity: 'warning', message: `${entry.ref}: ${t(r.key, r.params)}` });
  }
  return out;
}

function analyze() {
  const text = source.value;
  const parsed = safe('parse', () => k8s.parse(text), { docs: [], errors: [] });
  state.docs = parsed.docs;
  state.errors = parsed.errors;
  if (!state.docs.some((d) => d.index === state.selected)) state.selected = state.docs.at(-1)?.index ?? 0;
  state.images = safe('images', () => k8s.images(text), []);
  const image = state.linked ? state.docker?.image ?? null : null;
  const found = safe('validate', () => k8s.validate(text, { lang, image }),
    state.errors.map((e) => ({ severity: 'error', line: e.line, message: e.message })));
  state.diagnostics = [...found, ...imageDiagnostics()].sort((a, b) => a.line - b.line);
}

// ---------- autosave ----------
function autosave() {
  const secret = SECRET_KIND.test(source.value) || state.docs.some((d) => d.kind === 'Secret');
  if (secret && !state.secret) toast(t('k8s.ui.secretNotSaved'));
  state.secret = secret;
  $('notice').hidden = !secret;
  try {
    if (secret) localStorage.removeItem(STORE);
    else localStorage.setItem(STORE, JSON.stringify({ text: source.value, name: $('filename').value }));
  } catch (e) {
    console.warn('[STORE] autosave failed:', e.message);
  }
}

function refresh() {
  if (!k8s) return;
  analyze();
  autosave();
  renderEditor();
  renderDiagnostics();
  renderSide();
  scheduleLeft();
  $('undo').disabled = !state.history.length;
  $('redo').disabled = !state.future.length;
}

// ---------- editor ----------
function highlightLine(line) {
  const span = (cls, text) => h('span', { class: cls }, text);
  if (/^\s*#/.test(line)) return [span('com', line)];
  if (/^(---|\.\.\.)(\s|$)/.test(line)) return [span('var', line)];
  const out = [];
  let rest = line;
  const key = rest.match(/^(\s*(?:-\s+)?)("[^"]*"|'[^']*'|[^\s:#'"{[][^:#]*?)(:)(?=\s|$)/);
  if (key) {
    out.push(key[1], span('kw', key[2]), key[3]);
    rest = rest.slice(key[0].length);
  }
  const re = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|((?<=^|\s)#.*$)/g;
  let at = 0;
  for (const m of rest.matchAll(re)) {
    out.push(rest.slice(at, m.index), span(m[1] ? 'str' : 'com', m[0]));
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

function scrollToLine(line) {
  source.scrollTop = Math.max(0, (line - 5) * 20);
  syncScroll();
}

function goToLine(line) {
  const lines = source.value.split('\n');
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  source.focus();
  source.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  scrollToLine(line);
}

function select(index, { scroll = true } = {}) {
  if (!state.docs.some((d) => d.index === index)) return;
  state.selected = index;
  const doc = state.docs.find((d) => d.index === index);
  if (scroll) scrollToLine(doc.line);
  renderSide();
  scheduleLeft();
}

// The form follows the cursor in the editor.
function followCursor() {
  const line = source.value.slice(0, source.selectionStart).split('\n').length;
  const doc = state.docs.filter((d) => d.line <= line).at(-1) ?? state.docs[0];
  if (doc && doc.index !== state.selected) select(doc.index, { scroll: false });
}

function renderDiagnostics() {
  const count = (s) => state.diagnostics.filter((d) => d.severity === s).length;
  const errors = count('error');
  $('summary').replaceChildren(
    h('span', { class: errors ? 'text-error' : 'text-ok' }, errors ? t('ui.errors', { n: errors }) : t('ui.noErrors')),
    ` · ${t('ui.counts', { w: count('warning'), i: count('info') })}`,
  );
  $('diagnostics').replaceChildren(...state.diagnostics.map((d) => h('li', {},
    h('button', {
      class: d.severity,
      onclick: () => {
        if (d.doc !== undefined && d.doc !== null) select(d.doc, { scroll: false });
        goToLine(d.line);
      },
    },
    h('span', { class: 'tag' }, t(`ui.${d.severity}`)),
    h('span', { class: 'muted' }, t('ui.line', { line: d.line })),
    h('span', {}, d.message)))));
}

// ---------- left: documents and form ----------
const drafts = new Map(); // unsent values of the "add" inputs
const revealed = new Set(); // secret fields shown in plain text
let leftSignature = '';
let leftTimer;
let leftPending = false;
let pointerDown = false;
let rendering = false;

// Rebuilding the form is delayed until focus has moved and a pressed button has received its click.
function scheduleLeft() {
  clearTimeout(leftTimer);
  if (pointerDown) { leftPending = true; return; }
  leftTimer = setTimeout(renderLeft, 0);
}

const docName = (d) => d.name || t('k8s.ui.unnamed');
const docTitle = (d) => `${d.kind || t('k8s.ui.unknownKind')} ${docName(d)}`;

function addKind(kind, name) {
  const options = name ? { name } : {};
  const empty = !source.value.trim();
  const ok = edit((text) => (empty ? k8s.template(kind, options) : k8s.addDocument(text, kind, options)));
  if (!ok) return;
  select(state.docs.at(-1)?.index ?? 0);
  toast(t('k8s.ui.added', { kind }));
}

const starter = () => k8s.addDocument(k8s.template('Deployment', { name: 'my-app' }), 'Service', { name: 'my-app' });

const kindOptions = () => KINDS.map((kind) => h('option', { value: kind }, `${kind} · ${t(`k8s.ui.short.${kind}`)}`));

let addKindChoice = 'Service';
let addNameDraft = '';

function documentsCard() {
  const items = state.docs.map((d) => {
    const mine = state.diagnostics.filter((x) => x.doc === d.index);
    const errors = mine.filter((x) => x.severity === 'error').length;
    const warnings = mine.filter((x) => x.severity === 'warning').length;
    return h('li', {},
      h('button', { class: 'doc', 'aria-current': String(d.index === state.selected), onclick: () => select(d.index) },
        h('span', { class: 'badge' }, d.kind || t('k8s.ui.unknownKind')),
        h('span', { class: 'name' }, docName(d)),
        errors ? h('span', { class: 'dot text-error', title: t('ui.errors', { n: errors }) }, `✗${errors}`) : null,
        warnings ? h('span', { class: 'dot text-warning', title: t('ui.warning') }, `!${warnings}`) : null),
      h('button', {
        class: 'danger',
        title: t('k8s.ui.removeObject', { name: docTitle(d) }),
        'aria-label': t('k8s.ui.removeObject', { name: docTitle(d) }),
        onclick: () => {
          if (confirm(t('k8s.ui.confirmRemove', { name: docTitle(d) }))) edit((text) => k8s.removeDocument(text, d.index));
        },
      }, '×'));
  });

  const kind = h('select', { class: 'grow', 'aria-label': t('k8s.ui.kind'), onchange: () => { addKindChoice = kind.value; } }, kindOptions());
  kind.value = addKindChoice;
  const name = h('input', { class: 'mono', value: addNameDraft, placeholder: t('k8s.ui.optionalName'), 'aria-label': t('k8s.ui.optionalName'), oninput: () => { addNameDraft = name.value; } });
  name.dataset.key = 'new-name';

  return h('div', { class: 'card' },
    h('h2', {}, t('k8s.ui.objects')),
    items.length ? h('ul', { class: 'docs' }, items) : h('div', { class: 'empty' },
      h('div', { class: 'muted' }, t('k8s.ui.noObjects')),
      h('button', { class: 'primary', onclick: () => edit(starter) }, t('k8s.ui.starter'))),
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const chosen = name.value.trim();
        addNameDraft = '';
        addKind(kind.value, chosen);
      },
    },
    h('div', { class: 'row' }, kind),
    h('div', { class: 'row' }, name, h('button', { type: 'submit' }, t('k8s.ui.addObject')))));
}

function optionList(options) {
  return options.map((o) => (typeof o === 'object' && o !== null ? { value: String(o.value), label: o.label ?? String(o.value) } : { value: String(o), label: String(o) }));
}

// Empty input means "not set": numbers and selects drop the key, text keeps an empty string.
function commit(doc, field, raw) {
  if (rendering) return;
  edit((text) => {
    if (raw === '' && (field.type === 'number' || field.type === 'select')) return k8s.removeAt(text, doc, field.path);
    const value = field.type === 'number' && Number.isFinite(Number(raw)) && raw.trim() !== '' ? Number(raw) : raw;
    return k8s.setValue(text, doc, field.path, value);
  });
}

function fieldRow(doc, field, id) {
  const name = field.labelKey ? t(field.labelKey) : field.label ?? String(field.path.at(-1));
  const key = `${doc}|${JSON.stringify(field.path)}`;
  const value = field.value === undefined || field.value === null ? '' : String(field.value);
  const hidden = field.secret && !revealed.has(key);
  let control;
  if (field.type === 'boolean') {
    control = h('input', { id, type: 'checkbox', checked: field.value === true || field.value === 'true' });
  } else if (field.type === 'select') {
    const options = optionList(field.options ?? []);
    if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
    if (!options.some((o) => o.value === '')) options.unshift({ value: '', label: t('k8s.ui.notSet') });
    control = h('select', { id, class: 'mono' }, options.map((o) => h('option', { value: o.value }, o.label || t('k8s.ui.notSet'))));
    control.value = value;
  } else if (field.type === 'text' || value.includes('\n')) {
    control = h('textarea', { id, class: `mono${hidden ? ' masked' : ''}`, spellcheck: 'false', rows: Math.min(8, value.split('\n').length + 1) });
    control.value = value;
  } else {
    control = h('input', { id, class: 'mono', type: hidden ? 'password' : 'text', value, spellcheck: 'false', autocomplete: 'off', inputMode: field.type === 'number' ? 'numeric' : 'text' });
  }
  control.dataset.key = key;
  control.addEventListener('change', () => commit(doc, field, field.type === 'boolean' ? control.checked : control.value));

  return h('div', { class: 'field' },
    h('label', { htmlFor: id, title: field.path.join('.') }, name),
    h('div', { class: 'control' },
      control,
      field.secret ? h('button', {
        class: 'link',
        'aria-pressed': String(!hidden),
        onclick: () => {
          if (revealed.has(key)) revealed.delete(key);
          else revealed.add(key);
          leftSignature = '';
          scheduleLeft();
        },
      }, hidden ? t('k8s.ui.show') : t('k8s.ui.hide')) : null,
      field.removable ? h('button', {
        class: 'danger',
        title: t('k8s.ui.removeField', { name }),
        'aria-label': t('k8s.ui.removeField', { name }),
        onclick: () => edit((text) => k8s.removeAt(text, doc, field.path)),
      }, '×') : null));
}

function addForm(doc, kind, group) {
  const { add } = group;
  const title = add.labelKey ? t(add.labelKey) : t('ui.add');
  const controls = add.inputs.map((input, i) => {
    const label = input.labelKey ? t(input.labelKey) : input.label ?? input.name;
    const key = `add|${doc}|${group.id}|${JSON.stringify(add.path)}|${input.name}`;
    const secret = kind === 'Secret' && add.type === 'data' && i > 0;
    let control;
    if (input.type === 'select' || input.type === 'boolean') {
      const options = optionList(input.options ?? (input.type === 'boolean' ? ['false', 'true'] : []));
      control = h('select', { 'aria-label': label, title: label }, options.map((o) => h('option', { value: o.value }, o.label)));
    } else if (input.type === 'text') {
      control = h('textarea', { class: `mono${secret ? ' masked' : ''}`, placeholder: label, 'aria-label': label, spellcheck: 'false' });
    } else {
      control = h('input', { class: 'mono', type: secret ? 'password' : 'text', placeholder: label, 'aria-label': label, autocomplete: 'off', spellcheck: 'false', inputMode: input.type === 'number' ? 'numeric' : 'text' });
    }
    if (drafts.has(key)) control.value = drafts.get(key);
    control.dataset.key = key;
    control.addEventListener('input', () => drafts.set(key, control.value));
    return { name: input.name, key, control };
  });

  return h('form', {
    class: 'add',
    onsubmit: (e) => {
      e.preventDefault();
      const values = Object.fromEntries(controls.map((c) => [c.name, c.control.value]));
      if (controls.length && controls.every((c) => !c.control.value.trim())) { toast(t('ui.enterValue')); return; }
      const kept = controls.filter((c) => drafts.has(c.key)).map((c) => [c.key, drafts.get(c.key)]);
      for (const c of controls) drafts.delete(c.key);
      if (!edit((text) => k8s.addItem(text, doc, add, values))) for (const [k, v] of kept) drafts.set(k, v);
    },
  },
  h('div', { class: 'title' }, title),
  controls.map((c) => c.control),
  h('button', { type: 'submit' }, t('ui.add')));
}

function formCards() {
  const doc = state.docs.find((d) => d.index === state.selected);
  if (!doc) return [];
  const header = h('div', { class: 'card' },
    h('h2', {}, docTitle(doc)),
    KINDS.includes(doc.kind) ? h('p', { class: 'help' }, t(`k8s.ui.help.${doc.kind}`)) : null);

  let form = null;
  try {
    form = k8s.form(source.value, doc.index);
  } catch (e) {
    console.warn('[FORM] not available:', e.key ?? e.message);
    if (!state.errors.length) header.append(h('p', { class: 'text-error' }, errorText(e)));
  }

  if (!form?.groups?.length) {
    const broken = state.errors[0];
    if (broken) {
      header.append(
        h('p', { class: 'text-error' }, t('k8s.ui.syntaxFirst')),
        h('button', { onclick: () => goToLine(broken.line) }, t('k8s.ui.goToError', { line: broken.line })));
    } else {
      header.append(h('p', { class: 'muted' }, t('k8s.ui.textOnly')));
    }
    return [header];
  }

  let n = 0;
  return [header, ...form.groups.map((group) => h('div', { class: 'card' },
    h('h2', {}, [group.labelKey ? t(group.labelKey, group.params) : group.id, group.label].filter(Boolean).join(' · ')),
    group.fields.map((field) => fieldRow(doc.index, field, `field-${n++}`)),
    group.add ? addForm(doc.index, form.kind, group) : null))];
}

function renderLeft() {
  const signature = JSON.stringify([lang, state.selected, source.value, state.diagnostics.map((d) => `${d.doc}${d.severity}`)]);
  if (signature === leftSignature) return;
  leftSignature = signature;

  const left = $('left');
  const active = left.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = active?.dataset.key;
  const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = left.scrollTop;

  rendering = true;
  try {
    left.replaceChildren(
      h('ol', { class: 'steps' }, ['k8s.ui.step1', 'k8s.ui.step2', 'k8s.ui.step3'].map((key) => h('li', {}, t(key)))),
      documentsCard(),
      ...formCards());
  } finally {
    rendering = false;
  }

  left.scrollTop = scroll;
  if (!focusKey) return;
  const next = [...left.querySelectorAll('[data-key]')].find((el) => el.dataset.key === focusKey);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (caret && typeof next.selectionStart === 'number') next.setSelectionRange(...caret);
}

// ---------- right: connections, images, Dockerfile ----------
function renderOverview() {
  const { objects, links } = safe('summary', () => k8s.summary(source.value), { objects: [], links: [] });
  const nameOf = (index) => {
    const o = objects.find((x) => x.doc === index) ?? state.docs.find((x) => x.index === index);
    return o ? `${o.kind} ${o.name ?? t('k8s.ui.unnamed')}` : `#${index + 1}`;
  };
  const linkItem = (link) => {
    const missing = link.to === null || link.to === undefined;
    const target = missing ? `${link.label} (${t('k8s.ui.notInFile')})` : `${nameOf(link.to)}${link.label ? ` · ${link.label}` : ''}`;
    return h('li', { class: missing ? 'missing' : '' }, `→ ${t(`k8s.ui.link.${link.type}`)}: `,
      missing ? target : h('button', { class: 'link', onclick: () => select(link.to) }, target));
  };

  $('overview').replaceChildren(h('div', { class: 'card' },
    h('h2', {}, t('k8s.ui.overview')),
    objects.length ? objects.map((o) => {
      const out = links.filter((l) => l.from === o.doc);
      return h('div', {},
        h('button', { class: `object${o.doc === state.selected ? ' selected' : ''}`, onclick: () => select(o.doc) },
          h('strong', {}, o.kind ?? t('k8s.ui.unknownKind')), ' ', o.name ?? t('k8s.ui.unnamed'),
          (o.lines ?? []).map((line) => h('span', { class: 'line' }, line))),
        out.length ? h('ul', { class: 'links' }, out.map(linkItem)) : null);
    }) : h('div', { class: 'muted' }, t('k8s.ui.noOverview'))));
}

// Replaces the tag of every container that uses `ref`, found through the form fields.
function useTag(ref, tag) {
  const name = ref.split('@')[0];
  const repo = name.lastIndexOf(':') > name.lastIndexOf('/') ? name.slice(0, name.lastIndexOf(':')) : name;
  edit((text) => {
    let out = text;
    for (const doc of new Set(state.images.filter((i) => i.ref === ref).map((i) => i.doc))) {
      const fields = k8s.form(out, doc).groups.flatMap((g) => g.fields);
      for (const field of fields.filter((f) => f.value === ref && f.path.at(-1) === 'image')) {
        out = k8s.setValue(out, doc, field.path, `${repo}:${tag}`);
      }
    }
    return out;
  });
}

function imageStatus(ref) {
  const r = state.imageResults.get(ref);
  if (!r) return h('div', { class: 'muted' }, t('k8s.ui.notChecked'));
  if (r.status === 'checking') return h('div', { class: 'muted' }, t('ui.checking'));
  if (r.status === 'exists') {
    if (r.platformMissing) return h('div', { class: 'text-error' }, `✗ ${t('diag.platformMissing', { ref, platform: PLATFORM })}`);
    return h('div', { class: 'text-ok', title: r.digest ?? '' }, `✓ ${t('ui.exists', { ref })}`);
  }
  const bad = r.status === 'not_found' || r.status === 'invalid';
  return h('div', { class: bad ? 'text-error' : 'text-warning' }, `${bad ? '✗' : '?'} ${t(r.key, r.params)}`,
    r.suggestions?.length ? h('div', { class: 'muted' }, `${t('ui.similar')} `,
      r.suggestions.map((tag) => h('button', { class: 'link', onclick: () => useTag(ref, tag) }, `${tag} `))) : null);
}

function renderImages() {
  const refs = [...new Set(state.images.map((i) => i.ref).filter(Boolean))];
  $('images').replaceChildren(h('div', { class: 'card' },
    h('h2', {}, t('k8s.ui.imagesTitle')),
    refs.length ? [
      refs.map((ref) => h('div', { class: 'image' },
        h('button', {
          class: 'link mono',
          onclick: () => {
            const entry = state.images.find((i) => i.ref === ref);
            select(entry.doc, { scroll: false });
            goToLine(entry.line);
          },
        }, ref),
        imageStatus(ref))),
      h('button', { onclick: checkImages, disabled: $('check').disabled }, t('k8s.ui.check')),
    ] : h('div', { class: 'muted' }, t('k8s.ui.noImages'))));
}

function renderDockerfile() {
  const d = state.docker;
  const toggle = h('input', {
    type: 'checkbox',
    checked: state.linked,
    onchange: () => {
      state.linked = toggle.checked;
      try {
        localStorage.setItem(LINK_STORE, state.linked ? 'on' : 'off');
      } catch (e) {
        console.warn('[STORE] link setting not saved:', e.message);
      }
      refresh();
    },
  });
  const rows = d ? [
    [t('k8s.ui.linkedBase'), d.baseRef],
    ['EXPOSE', d.image.expose.join(', ') || t('ui.none')],
    ['USER', d.image.user ?? t('ui.none')],
    ['ENTRYPOINT', d.image.entrypoint ? JSON.stringify(d.image.entrypoint) : t('ui.none')],
    ['CMD', d.image.cmd ? JSON.stringify(d.image.cmd) : t('ui.none')],
  ] : [];
  $('dockerfile').replaceChildren(h('div', { class: 'card' },
    h('h2', {}, t('k8s.ui.linkedTitle')),
    h('label', { class: 'toggle' }, toggle, t('k8s.ui.linkedUse')),
    d ? [
      h('div', { class: 'mono' }, d.name),
      h('table', {}, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v))))),
      d.image.known ? null : h('p', { class: 'muted' }, t('k8s.ui.linkedUnknown')),
    ] : h('p', { class: 'muted' }, t('k8s.ui.linkedNone')),
    h('a', { href: './' }, t('k8s.ui.linkedOpen'))));
}

function renderSide() {
  renderOverview();
  renderImages();
  renderDockerfile();
}

// ---------- image check ----------
async function checkImages() {
  const refs = [...new Set(state.images.map((i) => i.ref).filter(Boolean))];
  if (!refs.length) { toast(t('ui.nothingToCheck')); return; }
  $('check').disabled = true;
  for (const ref of refs) state.imageResults.set(ref, { status: 'checking' });
  refresh();
  await Promise.all(refs.map(async (ref) => {
    try {
      const query = new URLSearchParams({ ref, platform: PLATFORM });
      const res = await fetch(`/api/check-image?${query}`);
      const body = await res.json();
      state.imageResults.set(ref, body.status ? body : { status: 'error', key: 'reg.http', params: { status: res.status } });
    } catch (e) {
      console.error('[CHECK] failed:', ref, e.message);
      state.imageResults.set(ref, { status: 'error', key: 'ui.serverDown' });
    }
  }));
  $('check').disabled = false;
  refresh();
}

// ---------- files ----------
function save() {
  const url = URL.createObjectURL(new Blob([source.value], { type: 'text/yaml' }));
  h('a', { href: url, download: $('filename').value || 'k8s.yaml' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.downloaded = source.value;
}

async function openFile(file) {
  if (!file || !k8s) return;
  if (file.size > MAX_FILE) { toast(t('ui.tooBig')); return; }
  try {
    const text = (await file.text()).replace(/\r\n?/g, '\n');
    $('filename').value = file.name;
    state.selected = 0;
    state.downloaded = text;
    revealed.clear();
    drafts.clear();
    if (text === source.value) refresh();
    else setText(text);
    toast(t('ui.opened', { name: file.name }));
  } catch (e) {
    console.error('[OPEN] failed:', file.name, e.message);
    toast(t('ui.readFailed'));
  }
}

// ---------- language ----------
function applyLanguage(next) {
  lang = normalizeLang(next);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.title = t('k8s.ui.pageTitle');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  $('new').replaceChildren(h('option', { value: '' }, t('ui.new')), ...(k8s ? kindOptions() : []));
  $('language').value = lang;
}

// ---------- events and start ----------
source.addEventListener('input', () => {
  const now = Date.now();
  if (now - typingAt > 800) remember(lastSaved);
  typingAt = now;
  lastSaved = source.value;
  refresh();
  followCursor();
});
source.addEventListener('scroll', syncScroll);
source.addEventListener('click', followCursor);
source.addEventListener('keyup', (e) => { if (/^(Arrow|Page|Home|End)/.test(e.key)) followCursor(); });
source.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (key === 'y') { e.preventDefault(); redo(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (k8s) save(); }
});
// A native select popup may swallow pointerup, so selects do not hold the form back.
document.addEventListener('pointerdown', (e) => { pointerDown = !e.target.closest?.('select'); }, true);
for (const type of ['pointerup', 'pointercancel', 'dragend']) {
  document.addEventListener(type, () => {
    pointerDown = false;
    if (leftPending) { leftPending = false; scheduleLeft(); }
  }, true);
}

$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('save').addEventListener('click', save);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('check').addEventListener('click', checkImages);
$('filename').addEventListener('change', autosave);
$('new').addEventListener('change', (e) => {
  const kind = e.target.value;
  e.target.value = '';
  if (KINDS.includes(kind)) addKind(kind);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});
// The Dockerfile may change in another tab.
window.addEventListener('storage', (e) => {
  if (e.key !== DOCKER_STORE) return;
  state.docker = readDockerfile();
  refresh();
});
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  state.docker = readDockerfile();
  refresh();
});
// A Secret has no autosaved copy, so leaving would lose unsaved work.
window.addEventListener('beforeunload', (e) => {
  if (state.secret && source.value !== state.downloaded) e.preventDefault();
});

for (const [code, name] of Object.entries(LANGUAGES)) $('language').append(h('option', { value: code }, name));
$('language').addEventListener('change', (e) => {
  applyLanguage(e.target.value);
  try {
    localStorage.setItem(LANG_STORE, lang);
  } catch (err) {
    console.warn('[STORE] language not saved:', err.message);
  }
  refresh();
});

let saved = null;
let savedLang = null;
try {
  savedLang = localStorage.getItem(LANG_STORE);
  state.linked = localStorage.getItem(LINK_STORE) !== 'off';
  saved = JSON.parse(localStorage.getItem(STORE));
} catch (e) {
  console.warn('[STORE] could not read saved content:', e.message);
}
// English is the default; ?lang= or an earlier choice overrides it.
const startLang = new URLSearchParams(location.search).get('lang') ?? savedLang ?? 'en';
applyLanguage(startLang);

try {
  const YAML = await import('/vendor/yaml/index.js');
  k8s = createK8s(YAML);
  source.value = saved?.text ?? starter();
  $('filename').value = saved?.name || 'k8s.yaml';
  lastSaved = source.value;
  state.docker = readDockerfile();
  for (const id of ['new', 'open', 'save', 'check', 'source']) $(id).disabled = false;
  applyLanguage(lang);
  refresh();
} catch (e) {
  console.error('[START] failed:', e);
  toast(t('k8s.ui.loadFailed'));
  $('left').replaceChildren(h('div', { class: 'card text-error' }, t('k8s.ui.loadFailed')));
}
