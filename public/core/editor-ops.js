// Editing operations that change only the necessary lines. All return a new string.

import { parse, splitStages, parsePairs } from './parser.js';
import { findStage, simulate } from './simulator.js';
import { LocalizedError } from './i18n.js';

const load = (text) => {
  const parsed = parse(text);
  return { parsed, ...splitStages(parsed), lines: [...parsed.lines] };
};
// Only normalise the trailing newline; collapsing blank lines could change heredocs.
const join = (lines) => lines.join('\n').replace(/\n*$/, '\n');

function oneLine(value) {
  if (/[\r\n]/.test(value)) throw new LocalizedError('edit.newline');
  return value.trim();
}

export function quoteValue(value) {
  if (/^[^\s"'\\]+$/.test(value)) return value;
  // Leave $ as is so variable expansion keeps working.
  return `"${value.replace(/\\(?!\$)/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const formatPair = (keyword, { key, value }) => (value === null && keyword === 'ARG' ? key : `${key}=${quoteValue(value ?? '')}`);

function findByLine(doc, startLine) {
  const ins = doc.parsed.instructions.find((i) => i.startLine === startLine);
  if (!ins) throw new LocalizedError('edit.noInstruction', { line: startLine });
  return ins;
}

export function replaceInstruction(text, startLine, newText) {
  const doc = load(text);
  const ins = findByLine(doc, startLine);
  doc.lines.splice(ins.startLine - 1, ins.endLine - ins.startLine + 1, ...newText.split('\n'));
  return join(doc.lines);
}

export function removeInstruction(text, startLine) {
  const doc = load(text);
  const ins = findByLine(doc, startLine);
  doc.lines.splice(ins.startLine - 1, ins.endLine - ins.startLine + 1);
  return join(doc.lines);
}

/** Replaces the pairIndex-th entry of ARG/ENV/LABEL; a null pair deletes it. */
export function setPair(text, startLine, pairIndex, pair) {
  const doc = load(text);
  const ins = findByLine(doc, startLine);
  const pairs = parsePairs(ins, doc.parsed.escape).pairs;
  if (pair === null) pairs.splice(pairIndex, 1);
  else pairs[pairIndex] = { key: oneLine(pair.key), value: pair.value === null ? null : oneLine(pair.value) };
  if (pairs.length === 0) return removeInstruction(text, startLine);
  // Keep multi-line instructions multi-line.
  const separator = ins.endLine > ins.startLine ? ` ${doc.parsed.escape}\n    ` : ' ';
  return replaceInstruction(text, startLine, `${ins.keyword} ${pairs.map((p) => formatPair(ins.keyword, p)).join(separator)}`);
}

export function buildLine(keyword, args) {
  return `${keyword} ${oneLine(args)}`;
}

export function buildPairLine(keyword, key, value) {
  const k = oneLine(key);
  const v = value === null ? null : oneLine(value);
  return `${keyword} ${formatPair(keyword, { key: k, value: v })}`;
}

/**
 * Inserts an instruction at a sensible position. stageIndex -1 is before the first FROM.
 */
export function addInstruction(text, stageIndex, line) {
  const doc = load(text);
  const keyword = line.split(/\s+/)[0].toUpperCase();
  let at; // insert before this 0-based position
  if (stageIndex < 0) {
    const last = doc.globals.at(-1);
    at = last ? last.endLine : doc.stages[0] ? doc.stages[0].startLine - 1 : doc.lines.length;
  } else {
    const stage = doc.stages[stageIndex];
    if (!stage) throw new LocalizedError('edit.noStage');
    const list = stage.instructions;
    const same = list.findLast((i) => i.keyword === keyword);
    const tail = list.find((i) => ['CMD', 'ENTRYPOINT'].includes(i.keyword));
    const end = (list.at(-1) ?? stage.from).endLine;
    if (keyword === 'ARG' || keyword === 'ENV') {
      const anchor = same ?? (keyword === 'ENV' ? list.findLast((i) => i.keyword === 'ARG') : null) ?? stage.from;
      at = anchor.endLine;
    } else if (keyword === 'CMD' || keyword === 'ENTRYPOINT') {
      at = end;
    } else {
      at = tail ? tail.startLine - 1 : end;
    }
  }
  doc.lines.splice(at, 0, line);
  return join(doc.lines);
}

const fromLine = ({ image, name, platform }) => [
  'FROM', platform ? `--platform=${platform}` : null, image, name ? `AS ${name}` : null,
].filter(Boolean).join(' ');

function checkName(doc, name, exceptIndex = -1) {
  if (!/^[a-z][a-z0-9_.-]*$/.test(name)) throw new LocalizedError('edit.stageNameRule');
  if (doc.stages.some((s) => s.index !== exceptIndex && s.name?.toLowerCase() === name)) throw new LocalizedError('edit.stageExists', { name });
}

// Rewrites --from= / from= references inside an instruction.
function rewriteRefs(lines, ins, map) {
  for (let i = ins.startLine - 1; i < ins.endLine; i++) {
    lines[i] = lines[i].replace(/(--from=|[=,]from=)([^\s,]+)/g, (m, prefix, ref) => {
      const next = map(ref);
      return next === undefined ? m : `${prefix}${next}`;
    });
    // Never touch heredoc bodies.
    if (ins.heredocs.length) break;
  }
}

/** Changes stage name / base image / platform, updating references on rename. */
export function setStageFrom(text, stageIndex, changes) {
  const doc = load(text);
  const stage = doc.stages[stageIndex];
  if (!stage) throw new LocalizedError('edit.noStage');
  const next = {
    image: oneLine(changes.image ?? stage.image),
    name: changes.name === undefined ? stage.name : oneLine(changes.name) || null,
    platform: changes.platform === undefined ? stage.platform : oneLine(changes.platform) || null,
  };
  if (!next.image || /\s/.test(next.image)) throw new LocalizedError('edit.imageSpace');
  if (next.name && next.name !== stage.name) checkName(doc, next.name, stageIndex);

  if (next.name !== stage.name && stage.name) {
    const old = stage.name.toLowerCase();
    const replacement = next.name ?? String(stageIndex);
    for (const other of doc.stages.slice(stageIndex + 1)) {
      if (other.image.toLowerCase() === old) {
        if (!next.name) throw new LocalizedError('edit.keepName');
        doc.lines.splice(other.from.startLine - 1, other.from.endLine - other.from.startLine + 1, fromLine({ ...other, image: next.name }));
      }
      for (const ins of other.instructions) {
        rewriteRefs(doc.lines, ins, (ref) => (ref.toLowerCase() === old ? replacement : undefined));
      }
    }
  }
  doc.lines.splice(stage.from.startLine - 1, stage.from.endLine - stage.from.startLine + 1, fromLine(next));
  return join(doc.lines);
}

function uniqueName(stages, base) {
  const taken = new Set(stages.map((s) => s.name?.toLowerCase()).filter(Boolean));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
}

/** Turns numeric references (--from=0) into names so stages can be added or removed safely. */
export function nameNumericRefs(text) {
  const doc = load(text);
  const targets = new Set();
  const forEachRef = (fn) => doc.stages.forEach((s) => s.instructions.forEach((ins) => rewriteRefs(doc.lines, ins, fn)));
  const original = [...doc.lines];
  forEachRef((ref) => {
    if (/^\d+$/.test(ref) && doc.stages[Number(ref)]) targets.add(Number(ref));
    return undefined;
  });
  if (targets.size === 0) return join(original);

  const names = new Map();
  for (const index of [...targets].sort((a, b) => a - b)) {
    const stage = doc.stages[index];
    const name = stage.name ?? uniqueName(doc.stages, `stage${index}`);
    names.set(index, name);
    stage.name = name;
  }
  forEachRef((ref) => names.get(/^\d+$/.test(ref) ? Number(ref) : NaN));
  // Rewrite FROM lines last, bottom up, so line numbers stay valid.
  for (const index of [...names.keys()].sort((a, b) => b - a)) {
    const stage = doc.stages[index];
    doc.lines.splice(stage.from.startLine - 1, stage.from.endLine - stage.from.startLine + 1, fromLine(stage));
  }
  return join(doc.lines);
}

export function addStage(text, { image, name }) {
  const doc = load(text);
  const img = oneLine(image);
  if (!img || /\s/.test(img)) throw new LocalizedError('edit.imageSpace');
  if (name) checkName(doc, name);
  const base = text.replace(/\n*$/, '');
  return `${base}${base ? '\n\n' : ''}${fromLine({ image: img, name })}\n`;
}

export function removeStage(text, stageIndex) {
  const doc = load(nameNumericRefs(text));
  const stage = doc.stages[stageIndex];
  if (!stage) throw new LocalizedError('edit.noStage');
  const sim = simulate(join(doc.lines));
  const users = sim.stages.filter((s) => s.deps.includes(stageIndex)).map((s) => s.name ?? `#${s.index}`);
  if (users.length) throw new LocalizedError('edit.inUse', { users: users.join(', ') });
  doc.lines.splice(stage.startLine - 1, stage.endLine - stage.startLine + 1);
  return join(doc.lines);
}

/**
 * Splits a new stage starting at the instruction on startLine.
 * With an empty base the new stage continues the previous one; with an image it starts fresh
 * and copies copyPath from the previous stage.
 */
export function splitStage(text, startLine, { name, base = '', copyPath = '' }) {
  const doc = load(nameNumericRefs(text));
  const before = parse(text).instructions.findIndex((i) => i.startLine === startLine);
  const ins = doc.parsed.instructions[before];
  const stage = ins && doc.stages.find((s) => s.instructions.includes(ins));
  if (!stage) throw new LocalizedError('edit.splitBelowFrom');
  checkName(doc, name);

  const prevName = stage.name ?? uniqueName([...doc.stages, { name }], name === 'build' ? 'base' : 'build');
  const image = oneLine(base) || prevName;
  const block = ['', fromLine({ image, name })];
  if (base && copyPath) {
    const path = oneLine(copyPath);
    block.push(`COPY --from=${prevName} ${path} ${path}`);
  }
  // Comments right above the split point move with the new stage.
  let at = ins.startLine - 1;
  while (at > 0 && doc.lines[at - 1].trim().startsWith('#')) at--;
  doc.lines.splice(at, 0, ...block);
  if (!stage.name) {
    doc.lines.splice(stage.from.startLine - 1, stage.from.endLine - stage.from.startLine + 1, fromLine({ ...stage, name: prevName }));
  }

  // Later references to the original stage must point at its final state (the new stage).
  let result = join(doc.lines);
  if (stage.name) {
    const next = load(result);
    const old = stage.name.toLowerCase();
    for (const other of next.stages.slice(stage.index + 2)) {
      for (const item of other.instructions) rewriteRefs(next.lines, item, (ref) => (ref.toLowerCase() === old ? name : undefined));
      if (other.image.toLowerCase() === old) {
        next.lines.splice(other.from.startLine - 1, other.from.endLine - other.from.startLine + 1, fromLine({ ...other, image: name }));
      }
    }
    result = join(next.lines);
  }
  return result;
}

/** Collects only what is needed to build one stage into a standalone file. */
export function extractStage(text, stageIndex) {
  const named = nameNumericRefs(text);
  const sim = simulate(named, { target: stageIndex });
  const doc = load(named);
  if (!findStage(doc.stages, String(stageIndex))) throw new LocalizedError('edit.noStage');
  const head = doc.lines.slice(0, doc.stages[0].startLine - 1);
  const body = [...sim.used].sort((a, b) => a - b)
    .map((i) => doc.lines.slice(doc.stages[i].startLine - 1, doc.stages[i].endLine).join('\n').replace(/\n*$/, ''));
  return join([...head, body.join('\n\n')].join('\n').split('\n'));
}
