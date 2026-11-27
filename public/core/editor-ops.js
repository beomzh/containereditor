// 원문을 최대한 보존하면서 필요한 줄만 고치는 편집 연산. 모두 새 문자열을 돌려준다.

import { parse, splitStages, parsePairs } from './parser.js';
import { findStage, simulate } from './simulator.js';

const load = (text) => {
  const parsed = parse(text);
  return { parsed, ...splitStages(parsed), lines: [...parsed.lines] };
};
// 끝 줄바꿈만 정리한다. 빈 줄을 합치면 heredoc 내용이 바뀔 수 있다.
const join = (lines) => lines.join('\n').replace(/\n*$/, '\n');

function oneLine(value, label) {
  if (/[\r\n]/.test(value)) throw new Error(`${label} 에는 줄바꿈을 넣을 수 없습니다.`);
  return value.trim();
}

export function quoteValue(value) {
  if (/^[^\s"'\\]+$/.test(value)) return value;
  // $ 는 그대로 두어 변수 치환이 유지되게 한다.
  return `"${value.replace(/\\(?!\$)/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const formatPair = (keyword, { key, value }) => (value === null && keyword === 'ARG' ? key : `${key}=${quoteValue(value ?? '')}`);

function findByLine(doc, startLine) {
  const ins = doc.parsed.instructions.find((i) => i.startLine === startLine);
  if (!ins) throw new Error(`${startLine}번 줄에 지시어가 없습니다.`);
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

/** ARG/ENV/LABEL 의 pairIndex 번째 항목을 바꾼다. pair 가 null 이면 삭제. */
export function setPair(text, startLine, pairIndex, pair) {
  const doc = load(text);
  const ins = findByLine(doc, startLine);
  const pairs = parsePairs(ins, doc.parsed.escape).pairs;
  if (pair === null) pairs.splice(pairIndex, 1);
  else pairs[pairIndex] = { key: oneLine(pair.key, '이름'), value: pair.value === null ? null : oneLine(pair.value, '값') };
  if (pairs.length === 0) return removeInstruction(text, startLine);
  // 여러 줄로 쓰던 지시어는 여러 줄 모양을 유지한다.
  const separator = ins.endLine > ins.startLine ? ` ${doc.parsed.escape}\n    ` : ' ';
  return replaceInstruction(text, startLine, `${ins.keyword} ${pairs.map((p) => formatPair(ins.keyword, p)).join(separator)}`);
}

export function buildLine(keyword, args) {
  return `${keyword} ${oneLine(args, keyword)}`;
}

export function buildPairLine(keyword, key, value) {
  const k = oneLine(key, '이름');
  const v = value === null ? null : oneLine(value, '값');
  return `${keyword} ${formatPair(keyword, { key: k, value: v })}`;
}

/**
 * 스테이지에 지시어를 알맞은 위치에 넣는다. stageIndex -1 은 첫 FROM 앞(전역 ARG).
 */
export function addInstruction(text, stageIndex, line) {
  const doc = load(text);
  const keyword = line.split(/\s+/)[0].toUpperCase();
  let at; // 이 0-기반 위치 앞에 삽입
  if (stageIndex < 0) {
    const last = doc.globals.at(-1);
    at = last ? last.endLine : doc.stages[0] ? doc.stages[0].startLine - 1 : doc.lines.length;
  } else {
    const stage = doc.stages[stageIndex];
    if (!stage) throw new Error('스테이지가 없습니다.');
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
  if (!/^[a-z][a-z0-9_.-]*$/.test(name)) throw new Error('스테이지 이름은 소문자로 시작하고 소문자·숫자·_.- 만 쓸 수 있습니다.');
  if (doc.stages.some((s) => s.index !== exceptIndex && s.name?.toLowerCase() === name)) throw new Error(`"${name}" 스테이지가 이미 있습니다.`);
}

// 지시어 범위 안의 --from=/from= 참조를 바꾼다.
function rewriteRefs(lines, ins, map) {
  for (let i = ins.startLine - 1; i < ins.endLine; i++) {
    lines[i] = lines[i].replace(/(--from=|[=,]from=)([^\s,]+)/g, (m, prefix, ref) => {
      const next = map(ref);
      return next === undefined ? m : `${prefix}${next}`;
    });
    // heredoc 본문은 건드리지 않는다.
    if (ins.heredocs.length) break;
  }
}

/** 스테이지 이름/베이스 이미지/플랫폼 변경. 이름이 바뀌면 참조도 함께 바꾼다. */
export function setStageFrom(text, stageIndex, changes) {
  const doc = load(text);
  const stage = doc.stages[stageIndex];
  if (!stage) throw new Error('스테이지가 없습니다.');
  const next = {
    image: oneLine(changes.image ?? stage.image, '이미지'),
    name: changes.name === undefined ? stage.name : oneLine(changes.name, '이름') || null,
    platform: changes.platform === undefined ? stage.platform : oneLine(changes.platform, '플랫폼') || null,
  };
  if (!next.image || /\s/.test(next.image)) throw new Error('이미지 이름은 공백 없이 입력하세요.');
  if (next.name && next.name !== stage.name) checkName(doc, next.name, stageIndex);

  if (next.name !== stage.name && stage.name) {
    const old = stage.name.toLowerCase();
    const replacement = next.name ?? String(stageIndex);
    for (const other of doc.stages.slice(stageIndex + 1)) {
      if (other.image.toLowerCase() === old) {
        if (!next.name) throw new Error('다른 스테이지가 FROM 으로 쓰고 있어 이름을 지울 수 없습니다.');
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

/** 번호 참조(--from=0)를 이름 참조로 바꾼다. 스테이지를 넣거나 지워도 안전해진다. */
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
  // 줄 수가 바뀌지 않도록 FROM 은 마지막에, 뒤에서부터 고친다.
  for (const index of [...names.keys()].sort((a, b) => b - a)) {
    const stage = doc.stages[index];
    doc.lines.splice(stage.from.startLine - 1, stage.from.endLine - stage.from.startLine + 1, fromLine(stage));
  }
  return join(doc.lines);
}

export function addStage(text, { image, name }) {
  const doc = load(text);
  const img = oneLine(image, '이미지');
  if (!img || /\s/.test(img)) throw new Error('이미지 이름은 공백 없이 입력하세요.');
  if (name) checkName(doc, name);
  const base = text.replace(/\n*$/, '');
  return `${base}${base ? '\n\n' : ''}${fromLine({ image: img, name })}\n`;
}

export function removeStage(text, stageIndex) {
  const doc = load(nameNumericRefs(text));
  const stage = doc.stages[stageIndex];
  if (!stage) throw new Error('스테이지가 없습니다.');
  const sim = simulate(join(doc.lines));
  const users = sim.stages.filter((s) => s.deps.includes(stageIndex)).map((s) => s.name ?? `#${s.index}`);
  if (users.length) throw new Error(`${users.join(', ')} 스테이지가 이 스테이지를 쓰고 있어 삭제할 수 없습니다.`);
  doc.lines.splice(stage.startLine - 1, stage.endLine - stage.startLine + 1);
  return join(doc.lines);
}

/**
 * startLine 의 지시어부터 새 스테이지로 분리한다.
 * base 를 비우면 이전 스테이지를 이어받고(FROM 이전), 이미지를 주면 새 베이스에서 시작하며
 * copyPath 를 이전 스테이지에서 가져온다.
 */
export function splitStage(text, startLine, { name, base = '', copyPath = '' }) {
  const doc = load(nameNumericRefs(text));
  const before = parse(text).instructions.findIndex((i) => i.startLine === startLine);
  const ins = doc.parsed.instructions[before];
  const stage = ins && doc.stages.find((s) => s.instructions.includes(ins));
  if (!stage) throw new Error('FROM 아래의 지시어를 골라야 분리할 수 있습니다.');
  checkName(doc, name);

  const prevName = stage.name ?? uniqueName([...doc.stages, { name }], name === 'build' ? 'base' : 'build');
  const image = oneLine(base, '이미지') || prevName;
  const block = ['', fromLine({ image, name })];
  if (base && copyPath) {
    const path = oneLine(copyPath, '복사 경로');
    block.push(`COPY --from=${prevName} ${path} ${path}`);
  }
  // 분리 지점 바로 위의 주석은 새 스테이지로 함께 옮긴다.
  let at = ins.startLine - 1;
  while (at > 0 && doc.lines[at - 1].trim().startsWith('#')) at--;
  doc.lines.splice(at, 0, ...block);
  if (!stage.name) {
    doc.lines.splice(stage.from.startLine - 1, stage.from.endLine - stage.from.startLine + 1, fromLine({ ...stage, name: prevName }));
  }

  // 원래 스테이지를 가리키던 뒤쪽 참조는 마지막 상태(새 스테이지)를 가리켜야 한다.
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

/** 한 스테이지를 빌드하는 데 필요한 부분만 모아 독립 파일로 만든다. */
export function extractStage(text, stageIndex) {
  const named = nameNumericRefs(text);
  const sim = simulate(named, { target: stageIndex });
  const doc = load(named);
  if (!findStage(doc.stages, String(stageIndex))) throw new Error('스테이지가 없습니다.');
  const head = doc.lines.slice(0, doc.stages[0].startLine - 1);
  const body = [...sim.used].sort((a, b) => a - b)
    .map((i) => doc.lines.slice(doc.stages[i].startLine - 1, doc.stages[i].endLine).join('\n').replace(/\n*$/, ''));
  return join([...head, body.join('\n\n')].join('\n').split('\n'));
}
