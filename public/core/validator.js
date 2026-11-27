// 문법 및 모범 사례 검사. severity: error(빌드 실패) / warning(위험) / info(개선 제안)

import { INSTRUCTIONS, parsePairs, splitFlags, parseExecForm, tokenize } from './parser.js';
import { parseImageRef } from './imageref.js';
import { simulate, findStage, AUTOMATIC_ARGS } from './simulator.js';

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

export function checkUserSpec(spec) {
  if (/\s/.test(spec)) return '공백을 포함할 수 없습니다. 형식은 USER 이름|UID[:그룹|GID] 입니다.';
  const parts = spec.replace(/\$\{[^}]*\}/g, '$V').split(':');
  if (parts.length > 2) return '":" 는 사용자와 그룹 사이에 한 번만 쓸 수 있습니다.';
  for (const [i, part] of parts.entries()) {
    const label = i === 0 ? '사용자' : '그룹';
    if (part === '') return `${label} 값이 비어 있습니다.`;
    if (VAR_ONLY.test(part)) continue;
    if (!ID.test(part)) return `${label} "${part}" 는 올바른 이름이나 숫자 ID 가 아닙니다.`;
    if (/^\d+$/.test(part) && Number(part) > 2147483647) return `${label} ID 가 허용 범위를 넘습니다.`;
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
  const out = [];
  const add = (severity, line, message, code) => out.push({ severity, line, message, code });
  const error = (line, m, code) => add('error', line, m, code);
  const warn = (line, m, code) => add('warning', line, m, code);
  const info = (line, m, code) => add('info', line, m, code);

  for (const issue of parsed.issues) add(issue.severity ?? 'error', issue.line, issue.message, 'parse');

  if (stages.length === 0) error(1, 'FROM 지시어가 필요합니다.', 'no-from');
  for (const ins of globals) {
    if (ins.keyword !== 'ARG' && INSTRUCTIONS.includes(ins.keyword)) {
      error(ins.startLine, `첫 FROM 앞에는 ARG 만 올 수 있습니다 (${ins.keyword}).`, 'before-from');
    }
  }

  const upper = parsed.instructions.filter((i) => i.rawKeyword === i.keyword).length;
  const majorityUpper = upper >= parsed.instructions.length / 2;
  for (const ins of parsed.instructions) {
    const consistent = majorityUpper ? ins.rawKeyword === ins.keyword : ins.rawKeyword === ins.keyword.toLowerCase();
    if (INSTRUCTIONS.includes(ins.keyword) && !consistent) info(ins.startLine, `지시어 대소문자를 통일하세요: ${ins.rawKeyword}`, 'casing');
    checkInstruction(ins);
  }

  function checkInstruction(ins, onbuild = false) {
    const line = ins.startLine;
    const { keyword, args } = ins;
    if (!INSTRUCTIONS.includes(keyword)) {
      const near = INSTRUCTIONS.map((k) => [k, distance(k, keyword)]).sort((a, b) => a[1] - b[1])[0];
      error(line, `알 수 없는 지시어 "${ins.rawKeyword}"${near[1] <= 2 ? ` — ${near[0]} 를 의도하셨나요?` : ''}`, 'unknown');
      return;
    }
    if (args === '') { error(line, `${keyword} 에 인자가 없습니다.`, 'empty'); return; }

    const { flags, rest } = splitFlags(args);
    if (FLAGS[keyword]) {
      for (const f of flags) {
        if (!FLAGS[keyword].includes(f.name)) error(line, `${keyword} 에서 지원하지 않는 옵션입니다: --${f.name}`, 'flag');
      }
    }

    switch (keyword) {
      case 'MAINTAINER':
        warn(line, 'MAINTAINER 는 폐기 예정입니다. LABEL maintainer="..." 를 쓰세요.', 'maintainer');
        break;
      case 'ENV':
      case 'LABEL':
      case 'ARG': {
        const { pairs, legacy, unterminated } = parsePairs(ins, parsed.escape);
        if (unterminated) error(line, '따옴표가 닫히지 않았습니다.', 'quote');
        if (legacy) {
          if (pairs[0].value === null) error(line, `${keyword} ${pairs[0].key} 에 값이 없습니다. ${keyword} key=value 형식으로 쓰세요.`, 'pair');
          else warn(line, `"${keyword} key value" 는 옛 형식입니다. ${keyword} key=value 를 쓰세요.`, 'legacy-pair');
        }
        for (const { key, value } of pairs) {
          if (!legacy && keyword !== 'ARG' && value === null) error(line, `"${key}" 에 "=" 와 값이 필요합니다.`, 'pair');
          if (keyword !== 'LABEL' && !/^[A-Za-z_]\w*$/.test(key)) error(line, `변수 이름이 잘못되었습니다: "${key}"`, 'var-name');
          if (keyword !== 'LABEL' && SECRET_NAME.test(key) && value !== '' && !/_(FILE|PATH)$/i.test(key)) {
            warn(line, `"${key}" 는 비밀값으로 보입니다. ARG/ENV 값은 이미지 기록에 남습니다. RUN --mount=type=secret 을 쓰세요.`, 'secret');
          }
        }
        break;
      }
      case 'USER': {
        const problem = checkUserSpec(args);
        if (problem) error(line, `USER: ${problem}`, 'user');
        break;
      }
      case 'WORKDIR':
        if (!args.startsWith('/') && !args.startsWith('$') && !/^[A-Za-z]:/.test(args)) {
          warn(line, 'WORKDIR 는 절대 경로를 권장합니다.', 'workdir');
        }
        break;
      case 'EXPOSE':
        for (const token of args.split(/\s+/)) {
          if (token.includes('$')) continue;
          const m = token.match(/^(\d+)(?:-(\d+))?(?:\/(\w+))?$/);
          const from = m && Number(m[1]);
          const to = m && Number(m[2] ?? m[1]);
          if (!m || from < 1 || to > 65535 || from > to) error(line, `포트가 잘못되었습니다: "${token}" (1-65535)`, 'port');
          else if (m[3] && !['tcp', 'udp', 'sctp'].includes(m[3].toLowerCase())) error(line, `프로토콜은 tcp, udp, sctp 중 하나여야 합니다: "${token}"`, 'port');
        }
        break;
      case 'CMD':
      case 'ENTRYPOINT': {
        const exec = parseExecForm(args);
        if (exec.form === 'invalid') warn(line, `${keyword}: ${exec.reason} 지금은 셸 명령으로 해석됩니다.`, 'json');
        else if (exec.form === 'shell') info(line, `${keyword} 는 exec 형식(["실행파일", "인자"])을 권장합니다. 셸 형식은 종료 신호가 앱에 전달되지 않을 수 있습니다.`, 'shell-form');
        break;
      }
      case 'SHELL': {
        const exec = parseExecForm(args);
        if (exec.form !== 'exec' || exec.value.length === 0) error(line, 'SHELL 은 JSON 배열 형식이어야 합니다.', 'json');
        break;
      }
      case 'VOLUME': {
        const exec = parseExecForm(args);
        if (exec.form === 'invalid') error(line, `VOLUME: ${exec.reason}`, 'json');
        break;
      }
      case 'STOPSIGNAL':
        if (!args.includes('$') && !SIGNALS.test(args)) error(line, `알 수 없는 신호입니다: ${args}`, 'signal');
        break;
      case 'HEALTHCHECK': {
        if (/^NONE$/i.test(rest)) break;
        if (!/^CMD(\s+|$)/i.test(rest)) error(line, 'HEALTHCHECK 는 "[옵션] CMD 명령" 또는 "NONE" 이어야 합니다.', 'healthcheck');
        else if (rest.replace(/^CMD\s*/i, '') === '') error(line, 'HEALTHCHECK CMD 뒤에 명령이 없습니다.', 'healthcheck');
        for (const f of flags) {
          if (f.name === 'retries' ? !/^\d+$/.test(f.value ?? '') : !/^(\d+(\.\d+)?(ms|s|m|h))+$|^0$/.test(f.value ?? '')) {
            error(line, `--${f.name} 값이 잘못되었습니다: ${f.value}`, 'healthcheck');
          }
        }
        break;
      }
      case 'COPY':
      case 'ADD': {
        const exec = parseExecForm(rest);
        if (exec.form === 'invalid') { error(line, `${keyword}: ${exec.reason}`, 'json'); break; }
        const { tokens, unterminated } = tokenize(rest, parsed.escape);
        if (unterminated) error(line, '따옴표가 닫히지 않았습니다.', 'quote');
        const parts = exec.form === 'exec' ? exec.value : tokens.map((t) => t.value);
        if (parts.length < 2) { error(line, `${keyword} 에는 원본과 대상이 모두 필요합니다.`, 'copy-args'); break; }
        const sources = parts.slice(0, -1);
        const dest = parts.at(-1);
        if ((sources.length > 1 || sources.some((s) => /[*?]/.test(s))) && !dest.endsWith('/') && dest !== '.') {
          if (sources.length > 1) error(line, '원본이 여러 개면 대상은 "/" 로 끝나야 합니다.', 'copy-dest');
          else warn(line, '와일드카드가 여러 파일에 일치하면 대상이 "/" 로 끝나야 합니다.', 'copy-dest');
        }
        const from = flags.find((f) => f.name === 'from')?.value;
        if (from === undefined && sources.some((s) => s === '..' || s.startsWith('../'))) {
          error(line, '빌드 컨텍스트 바깥(../)의 파일은 복사할 수 없습니다.', 'context');
        }
        const chown = flags.find((f) => f.name === 'chown')?.value;
        if (chown !== undefined) {
          const problem = checkUserSpec(chown ?? '');
          if (problem) error(line, `--chown: ${problem}`, 'user');
        }
        const chmod = flags.find((f) => f.name === 'chmod')?.value;
        if (chmod && !chmod.includes('$') && !/^[0-7]{3,4}$|^[ugoa]*[+=-][rwxXst]+(,[ugoa]*[+=-][rwxXst]+)*$/.test(chmod)) {
          error(line, `--chmod 값이 잘못되었습니다: ${chmod}`, 'chmod');
        }
        if (keyword === 'ADD' && sources.every((s) => !/^(https?:\/\/|git@)|\.(tar|tgz|tar\.\w+)$|\.git(#|$)|^<</.test(s))) {
          info(line, '단순 파일 복사에는 ADD 대신 COPY 를 권장합니다.', 'add');
        }
        break;
      }
      case 'RUN': {
        const body = [rest, ...ins.heredocs.flatMap((d) => d.lines)].join('\n');
        if (parseExecForm(rest).form === 'invalid') warn(line, `RUN: ${parseExecForm(rest).reason}`, 'json');
        if (/apt-get\s+(?:-\S+\s+)*install\b/.test(body)) {
          if (!/apt-get[^;&|\n]*\s(-\w*y\w*|--yes|--assume-yes|-qq)\b/.test(body)) warn(line, 'apt-get install 에 -y 가 없으면 빌드가 중단됩니다.', 'apt-yes');
          if (!/apt-get[^;&|\n]*\bupdate\b/.test(body)) warn(line, 'apt-get update 를 같은 RUN 에서 실행하세요. 캐시 때문에 설치가 실패할 수 있습니다.', 'apt-update');
          if (!body.includes('/var/lib/apt/lists')) info(line, '설치 후 rm -rf /var/lib/apt/lists/* 로 이미지 크기를 줄일 수 있습니다.', 'apt-clean');
        }
        if (/apk\s+add\b/.test(body) && !/--no-cache|\/var\/cache\/apk/.test(body)) info(line, 'apk add 에 --no-cache 를 권장합니다.', 'apk');
        if (/(^|&&|;|\|)\s*sudo\s/.test(body)) warn(line, 'sudo 는 대개 필요 없습니다. USER 로 권한을 전환하세요.', 'sudo');
        if (/^cd\s+[^;&|]+$/.test(rest)) warn(line, 'RUN cd 는 다음 지시어에 유지되지 않습니다. WORKDIR 를 쓰세요.', 'cd');
        break;
      }
      case 'ONBUILD': {
        if (onbuild) break;
        const [, kw, tail = ''] = args.match(/^(\S+)\s*([\s\S]*)$/);
        const upperKw = kw.toUpperCase();
        if (['ONBUILD', 'FROM', 'MAINTAINER'].includes(upperKw)) error(line, `ONBUILD 뒤에 ${upperKw} 는 올 수 없습니다.`, 'onbuild');
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
    if (unknownFlags.length) error(line, `FROM 에서 지원하지 않는 옵션입니다: ${unknownFlags.join(' ')}`, 'flag');
    if (stage.malformed || !stage.image) {
      error(line, 'FROM 형식은 "FROM [--platform=…] 이미지[:태그] [AS 이름]" 입니다.', 'from-syntax');
    }
    if (stage.name) {
      const lower = stage.name.toLowerCase();
      if (!/^[a-z][a-z0-9_.-]*$/i.test(stage.name)) error(line, `스테이지 이름이 잘못되었습니다: "${stage.name}" (영문자로 시작)`, 'stage-name');
      if (stage.name !== lower) warn(line, `스테이지 이름은 소문자를 권장합니다: "${stage.name}"`, 'stage-name');
      if (names.has(lower)) error(line, `스테이지 이름 "${stage.name}" 이 중복됩니다 (${names.get(lower)}번 줄).`, 'stage-dup');
      names.set(lower, line);
    }

    const baseRef = result.baseRef;
    const missing = sim.undefinedVars.filter((v) => v.inFrom && v.stage === stage.index);
    for (const v of missing) error(line, `FROM 의 \${${v.name}} 값이 없습니다. 첫 FROM 앞에 ARG ${v.name}=기본값 을 선언하세요.`, 'from-var');
    if (missing.length === 0 && result.parentIndex === null && baseRef !== 'scratch' && stage.image) {
      const later = stages.slice(stage.index).find((s) => s.name?.toLowerCase() === baseRef.toLowerCase());
      if (baseRef === '') error(line, 'FROM 의 이미지 값이 비어 있습니다.', 'from-empty');
      else if (later) error(line, `"${baseRef}" 는 아직 정의되지 않은 스테이지입니다. 앞선 스테이지만 참조할 수 있습니다.`, 'stage-order');
      else {
        const ref = parseImageRef(baseRef);
        if (!ref.ok) error(line, `FROM 이미지: ${ref.error}`, 'from-ref');
        else if (!ref.digest && ref.tag === 'latest') {
          warn(line, ref.explicitTag ? 'latest 태그는 빌드할 때마다 내용이 달라질 수 있습니다. 버전을 고정하세요.' : '태그가 없으면 latest 가 사용됩니다. 버전을 고정하세요.', 'latest');
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
          if (ins.keyword === 'COPY') error(ins.startLine, 'COPY --from 에는 변수를 쓸 수 없습니다.', 'copy-from');
          continue;
        }
        if (findStage(stages, ref, stage.index)) continue;
        const self = ref.toLowerCase() === stage.name?.toLowerCase() || ref === String(stage.index);
        if (self) error(ins.startLine, `자기 자신 스테이지("${ref}")는 참조할 수 없습니다.`, 'copy-from');
        else if (findStage(stages, ref)) error(ins.startLine, `"${ref}" 는 뒤에 정의된 스테이지입니다.`, 'stage-order');
        else if (/^\d+$/.test(ref)) error(ins.startLine, `스테이지 번호 ${ref} 가 없습니다.`, 'copy-from');
        else if (!parseImageRef(ref).ok) error(ins.startLine, `--from 값이 잘못되었습니다: "${ref}"`, 'copy-from');
        else info(ins.startLine, `"${ref}" 스테이지가 없어 외부 이미지로 간주합니다. 오타가 아닌지 확인하세요.`, 'external-from');
      }
    }

    for (const kw of ['CMD', 'ENTRYPOINT', 'HEALTHCHECK']) {
      const list = stage.instructions.filter((i) => i.keyword === kw);
      for (const ins of list.slice(0, -1)) warn(ins.startLine, `한 스테이지에서 ${kw} 는 마지막 것만 적용됩니다.`, 'override');
    }
  }

  for (const v of sim.undefinedVars) {
    if (v.inFrom) continue;
    const isGlobal = sim.globalArgs.some((a) => a.key === v.name);
    if (isGlobal) warn(v.line, `\${${v.name}} 는 전역 ARG 입니다. 스테이지 안에서 "ARG ${v.name}" 을 다시 선언해야 값이 전달됩니다.`, 'global-arg');
    else if (AUTOMATIC_ARGS.includes(v.name)) warn(v.line, `\${${v.name}} 를 쓰려면 "ARG ${v.name}" 선언이 필요합니다.`, 'auto-arg');
    else if (v.baseKnown) warn(v.line, `정의되지 않은 변수입니다: \${${v.name}}`, 'undefined-var');
    else info(v.line, `\${${v.name}} 를 이 파일에서 찾을 수 없습니다. 베이스 이미지에 없다면 빈 값이 됩니다. (FROM 확인 후 다시 판단)`, 'undefined-var');
  }

  sim.stages.forEach((s) => {
    if (!sim.used.has(s.index) && s.index < sim.targetIndex) {
      warn(stages[s.index].from.startLine, `스테이지 ${s.name ?? s.index} 는 최종 결과에 쓰이지 않습니다.`, 'unused-stage');
    }
  });

  const final = sim.stages[sim.targetIndex];
  if (final) {
    const line = stages[final.index].from.startLine;
    const user = final.state.user;
    const userLine = findUserLine(final.index);
    const root = user !== null && /^(root|0)(:|$)/.test(user);
    if (root) warn(userLine ?? line, '최종 이미지가 root 로 실행됩니다. 일반 사용자를 쓰세요.', 'root');
    else if (user === null && final.baseRef !== 'scratch') {
      if (final.baseKnown) warn(line, '최종 이미지가 root 로 실행됩니다. USER 를 추가하세요.', 'root');
      else info(line, 'USER 가 없습니다. 베이스 이미지가 따로 지정하지 않았다면 root 로 실행됩니다.', 'root');
    }
  }

  // 이름으로 지정한 USER 가 실제로 만들어지는지 확인
  for (const stage of stages) {
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
      if (!created) info(ins.startLine, `사용자 "${name}" 를 만드는 명령(useradd/adduser)이 보이지 않습니다. 베이스 이미지에 없으면 실행 시 실패합니다.`, 'user-missing');
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
