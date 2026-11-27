// "Build" tab: choose what to produce, see where it will go, run the build and read the log.

import { translate } from './core/i18n.js';

const DEFAULT_DEST = { archive: 'out/image.tar', folder: 'out/rootfs' };

// The token arrives in the URL fragment and is kept for this tab only.
function readToken() {
  const found = location.hash.match(/token=([0-9a-f]+)/);
  try {
    if (found) {
      sessionStorage.setItem('dockereditor.token', found[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem('dockereditor.token') ?? '';
  } catch (e) {
    console.warn('[BUILD] sessionStorage unavailable:', e);
    return found?.[1] ?? '';
  }
}

export function createBuildPanel({ root, h, t, toast, current }) {
  const token = readToken();
  const message = (m) => (m?.key ? t(m.key, m.params) : m?.message ?? translate('en', 'build.failed', { code: '?' }));
  const state = { enabled: null, engine: null, output: 'image', context: '.', tag: 'myimage:latest', dest: '', running: null, log: '', outcome: null, planSeq: 0 };
  let els = {};
  let timer;

  const api = (path, body, signal) => fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Build-Token': token },
    body: JSON.stringify(body ?? {}),
    signal,
  });

  const request = () => {
    const { content, platform, buildArgs, target } = current();
    return {
      content, buildArgs, target,
      // The editor platform list includes 32-bit ARM, which the builder also accepts.
      platform, context: state.context, output: state.output, tag: state.tag,
      dest: state.output === 'image' ? '' : state.dest,
    };
  };

  function cliCommand() {
    const { filename } = current();
    const quote = (v) => (/^[\w./:=-]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`);
    return ['dockereditor build', quote(filename), `--platform ${current().platform}`, `--output ${state.output}`,
      state.output === 'folder' ? null : `--tag ${quote(state.tag)}`,
      state.output === 'image' ? null : `--dest ${quote(state.dest)}`].filter(Boolean).join(' ');
  }

  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast(t('ui.copied')), () => toast(t('ui.copyFailed')));
  const commandBlock = (text) => [h('pre', { class: 'block mono' }, text), h('button', { onclick: () => copy(text) }, t('ui.copy'))];

  function field(labelKey, name) {
    const input = h('input', { class: 'mono', value: state[name], spellcheck: false });
    input.addEventListener('input', () => { state[name] = input.value; state.outcome = null; drawOutcome(); schedule(); });
    return h('label', { class: 'field' }, h('span', {}, t(labelKey)), input);
  }

  function draw() {
    if (state.enabled === null) { root.replaceChildren(h('div', { class: 'card muted' }, '…')); return; }
    if (!state.enabled || !token) {
      els = { command: h('div') };
      root.replaceChildren(
        h('div', { class: 'card' }, h('p', {}, t('ui.buildOff')), commandBlock('dockereditor serve --allow-build')),
        h('div', { class: 'card' }, h('h2', {}, t('ui.command')), els.command));
      els.command.replaceChildren(...commandBlock(cliCommand()));
      return;
    }
    const outputs = [['image', 'ui.outImage'], ['archive', 'ui.outArchive'], ['folder', 'ui.outFolder']].map(([value, key]) => {
      const radio = h('input', { type: 'radio', name: 'output', value, checked: state.output === value });
      radio.addEventListener('change', () => { state.output = value; state.dest = DEFAULT_DEST[value] ?? ''; state.outcome = null; draw(); });
      return h('label', { class: `choice${state.output === value ? ' on' : ''}` }, radio, t(key));
    });
    els = {
      where: h('div', { class: 'where', role: 'status' }),
      command: h('div'),
      run: h('button', { class: 'primary', onclick: start }, t('ui.build')),
      cancel: h('button', { onclick: () => state.running?.abort() }, t('ui.cancel')),
      log: h('pre', { class: 'block mono log' }, state.log),
      outcome: h('div'),
    };
    const { engine } = state;
    root.replaceChildren(
      h('div', { class: 'card text-warning' }, t('ui.runsCode')),
      h('div', { class: 'card' },
        h('div', { class: 'muted' }, t('ui.workspace', { path: engine?.workspace ?? '' })),
        h('div', { class: engine?.daemon ? 'muted' : 'text-error' }, engine?.daemon
          ? t('ui.engine', { engine: engine.daemon.engine, version: engine.daemon.version, platform: `${engine.daemon.os}/${engine.daemon.arch}` })
          : message(engine?.error)),
        field('ui.contextDir', 'context'),
        h('fieldset', {}, h('legend', {}, t('ui.outputType')), outputs),
        state.output === 'folder' ? null : field('ui.tag', 'tag'),
        state.output === 'image' ? null : field('ui.dest', 'dest')),
      h('div', { class: 'card' }, h('h2', {}, t('ui.resultWhere')), els.where),
      h('div', { class: 'row' }, els.run, els.cancel),
      els.outcome, els.log,
      h('div', { class: 'card' }, h('h2', {}, t('ui.command')), els.command));
    drawRunState();
    drawOutcome();
    plan();
  }

  function drawRunState() {
    if (!els.run) return;
    els.run.disabled = Boolean(state.running);
    els.run.textContent = state.running ? t('ui.building') : t('ui.build');
    els.cancel.hidden = !state.running;
    els.log.hidden = !state.log;
  }

  function drawOutcome() {
    if (!els.outcome) return;
    const o = state.outcome;
    if (!o) { els.outcome.replaceChildren(); return; }
    els.outcome.replaceChildren(h('div', { class: `card ${o.ok ? 'text-ok' : 'text-error'}` },
      h('h2', {}, o.ok ? t('build.done') : o.text ?? t('build.failed', { code: o.code })),
      o.ok && o.location ? h('div', { class: 'mono' }, t(o.location.key, o.location.params)) : null,
      o.result ? h('div', { class: 'mono' }, t(o.result.key, o.result.params)) : null,
      (o.result?.entries ?? []).map((entry) => h('div', { class: 'mono muted' }, entry))));
  }

  async function plan() {
    if (!els.where) return;
    const seq = ++state.planSeq;
    try {
      const res = await api('/api/plan', request());
      const body = await res.json();
      if (seq !== state.planSeq) return;
      if (!res.ok) {
        els.where.replaceChildren(h('div', { class: 'text-error' }, message(body)));
        els.command.replaceChildren(...commandBlock(cliCommand()));
        return;
      }
      els.where.replaceChildren(...[
        h('div', { class: 'mono' }, t(body.location.key, body.location.params)),
        body.storage && body.location.type === 'image' ? h('div', { class: 'muted mono' }, t('build.storage', { path: body.storage })) : null,
        ...body.warnings.map((w) => h('div', { class: 'text-warning' }, message(w))),
      ].filter(Boolean));
      els.command.replaceChildren(...commandBlock(body.commands.join('\n')));
    } catch (e) {
      console.error('[BUILD] plan failed:', e);
      if (seq === state.planSeq) els.where.replaceChildren(h('div', { class: 'text-error' }, t('ui.serverDown')));
    }
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(plan, 400); };

  async function start() {
    if (state.running) return;
    const abort = new AbortController();
    state.running = abort;
    state.log = '';
    state.outcome = null;
    drawRunState();
    drawOutcome();
    let location = null;
    const handle = (event) => {
      if (event.type === 'plan') location = event.location;
      else if (event.type === 'log') {
        state.log = (state.log + event.text).slice(-60_000);
        if (els.log) {
          els.log.hidden = false;
          els.log.textContent = state.log;
          els.log.scrollTop = els.log.scrollHeight;
        }
      } else if (event.type === 'done') state.outcome = { ...event, location, text: event.message };
    };
    try {
      const res = await api('/api/build', request(), abort.signal);
      if (!res.ok) {
        state.outcome = { ok: false, text: message(await res.json()) };
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line) handle(JSON.parse(line));
      }
    } catch (e) {
      console.warn('[BUILD] stopped:', e);
      state.outcome = { ok: false, text: e.name === 'AbortError' ? t('ui.cancelled') : t('ui.serverDown') };
    } finally {
      state.running = null;
      drawRunState();
      drawOutcome();
    }
  }

  async function load() {
    try {
      const info = await (await fetch('/api/info')).json();
      state.enabled = info.buildEnabled;
      if (state.enabled && token) {
        const res = await api('/api/engine');
        const body = await res.json();
        state.engine = res.ok ? body : { daemon: null, error: body };
        if (body.workspace) state.context = '.';
      }
    } catch (e) {
      console.error('[BUILD] info failed:', e);
      state.enabled = false;
    }
    draw();
  }
  let loaded = false;

  return {
    // Called when the tab is shown or the document changes; inputs are kept as they are.
    update() {
      if (!loaded) { loaded = true; draw(); load(); return; }
      if (els.where) schedule();
      else if (els.command) els.command.replaceChildren(...commandBlock(cliCommand()));
    },
    relabel() { if (loaded) draw(); },
  };
}
