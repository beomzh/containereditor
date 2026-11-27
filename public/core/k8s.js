// Kubernetes / OpenShift YAML: parsing, checks, form model and comment-preserving edits.
// Runs in the browser and in node. The yaml library is injected through createK8s().

import { LocalizedError, translate, normalizeLang, LANGUAGES } from './i18n.js';
import { K8S_MESSAGES } from './k8s-i18n.js';
import { parseImageRef } from './imageref.js';

export const KINDS = ['Deployment', 'StatefulSet', 'Job', 'CronJob', 'Service', 'ConfigMap', 'Secret', 'Ingress', 'Route', 'PersistentVolumeClaim'];

const API_VERSIONS = {
  Deployment: 'apps/v1', StatefulSet: 'apps/v1', Job: 'batch/v1', CronJob: 'batch/v1', Service: 'v1',
  ConfigMap: 'v1', Secret: 'v1', Ingress: 'networking.k8s.io/v1', Route: 'route.openshift.io/v1', PersistentVolumeClaim: 'v1',
};
const POD_PATHS = {
  Deployment: ['spec', 'template'],
  StatefulSet: ['spec', 'template'],
  Job: ['spec', 'template'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template'],
};

// Limits that keep hostile input (huge files, alias bombs) from hanging the page.
const MAX_LENGTH = 512 * 1024;
const MAX_DOCS = 200;
const MAX_ALIASES = 100;
const MAX_DIAGNOSTICS_PER_DOC = 100;

const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SERVICE_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const DATA_KEY = /^[-._a-zA-Z0-9]+$/;
const QUANTITY = /^\+?(\d+(?:\.\d*)?|\.\d+)(m|n|u|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?\d+)?$/;
const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)/i;
const NOT_A_SECRET = /([_.-](FILE|PATH|DIR|NAME)|(File|Path))$/i;
const URL_CREDENTIALS = /:\/\/[^/\s:@]{1,200}:[^/\s@]{1,200}@/;
// Plain scalars that YAML 1.1 readers (including kubectl) do not treat as strings.
const AMBIGUOUS = /^(?:|~|null|true|false|yes|no|on|off|y|n|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])*(?:\.[0-9_]*)?(?:[eE][-+]?\d+)?|[-+]?\.[0-9]+|0x[0-9a-f_]+|0o?[0-7_]+|0b[01_]+|[-+]?\.inf|\.nan|\d{4}-\d\d?-\d\d?(?:[Tt ].*)?)$/i;

const NUMBER_KEYS = new Set([
  'replicas', 'containerPort', 'port', 'number', 'targetPort', 'nodePort', 'hostPort', 'backoffLimit', 'runAsUser', 'runAsGroup', 'fsGroup',
  'completions', 'parallelism', 'successfulJobsHistoryLimit', 'failedJobsHistoryLimit', 'activeDeadlineSeconds',
  'ttlSecondsAfterFinished', 'terminationGracePeriodSeconds', 'revisionHistoryLimit',
]);
const BOOLEAN_KEYS = new Set(['runAsNonRoot', 'privileged', 'allowPrivilegeEscalation', 'readOnlyRootFilesystem', 'automountServiceAccountToken', 'suspend', 'hostNetwork']);
const STRING_MAPS = new Set(['data', 'stringData', 'binaryData', 'annotations', 'labels', 'matchLabels', 'selector', 'nodeSelector']);
// Fields where an empty value means "remove the key".
const OPTIONAL_KEYS = new Set([
  ...NUMBER_KEYS, ...BOOLEAN_KEYS, 'namespace', 'cpu', 'memory', 'storage', 'imagePullPolicy', 'storageClassName', 'ingressClassName',
  'host', 'termination', 'concurrencyPolicy', 'restartPolicy', 'serviceName', 'type', 'command', 'args', 'protocol',
]);
// Empty parents that are dropped together with their last child.
const PRUNABLE = new Set([
  'env', 'ports', 'resources', 'requests', 'limits', 'securityContext', 'annotations', 'labels', 'data', 'stringData',
  'command', 'args', 'tls', 'port', 'selector', 'rules', 'paths',
]);

// ---------- small helpers ----------

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const map = (v) => (isMap(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const entries = (v) => Object.entries(map(v));
/** Text of a scalar value, or null for anything else (never calls toString on user objects). */
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const get = (obj, path) => path.reduce((v, key) => (v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined), obj);
const clip = (v, n = 80) => {
  const s = str(v) ?? (v === null || v === undefined ? '' : '…');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const dotted = (path) => path.reduce((out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${key}` : String(key)), '');
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const selectorText = (selector) => entries(selector).map(([k, v]) => `${k}=${clip(v)}`).join(',');

function t(lang, key, params = {}) {
  const entry = Object.hasOwn(K8S_MESSAGES, key) ? K8S_MESSAGES[key] : null;
  if (!entry) return translate(lang, key, params);
  return entry[Object.keys(LANGUAGES).indexOf(normalizeLang(lang))]
    .replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

function fail(key, params = {}) {
  const error = new LocalizedError(key, params);
  error.message = t('en', key, params);
  throw error;
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** { valid, text } where text is null when the bytes are not UTF-8. */
function decodeBase64(value) {
  const compact = value.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return { valid: false, text: null };
  try {
    const bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    return { valid: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch (e) {
    return { valid: e instanceof TypeError, text: null };
  }
}

function quantity(value) {
  const m = QUANTITY.exec(str(value) ?? '');
  if (!m) return null;
  const suffix = m[2] ?? '';
  const scale = { '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
  return Number(m[1]) * (Object.hasOwn(scale, suffix) ? scale[suffix] : 10 ** Number(suffix.slice(1)));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12, MONTHS, 1], [0, 6, WEEKDAYS, 0]];

function validSchedule(value) {
  const s = value.trim();
  if (s.length > 200) return false;
  if (/^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(s) || /^@every (\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(s)) return true;
  const fields = s.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const [min, max, names, base] = CRON_FIELDS[i];
    const number = (x) => {
      if (/^\d+$/.test(x)) return Number(x);
      const at = names ? names.indexOf(x.toLowerCase()) : -1;
      return at < 0 ? NaN : at + base;
    };
    return field.split(',').every((part) => {
      const m = /^(\*|\?|[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?)(?:\/(\d+))?$/.exec(part);
      if (!m || (m[2] !== undefined && Number(m[2]) === 0)) return false;
      if (m[1] === '*' || m[1] === '?') return true;
      const [from, to = from] = m[1].split('-').map(number);
      return from >= min && to <= max && from <= to;
    });
  });
}

function validName(kind, name) {
  if (kind === 'Service') return name.length <= 63 && SERVICE_NAME.test(name);
  const max = kind === 'CronJob' ? 52 : kind === 'Job' || kind === 'StatefulSet' ? 63 : 253;
  return name.length <= max && SUBDOMAIN.test(name);
}

/** The kind when this editor understands the object, otherwise null (e.g. a Knative "Service"). */
function knownKind(js) {
  const kind = str(map(js).kind);
  if (!KINDS.includes(kind)) return null;
  const apiVersion = str(js.apiVersion) ?? '';
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
  const expected = API_VERSIONS[kind].includes('/') ? API_VERSIONS[kind].split('/')[0] : '';
  if (group.includes('.') && group !== expected && !group.endsWith('.k8s.io')) return null;
  return kind;
}

function podInfo(js) {
  const kind = knownKind(js);
  if (!kind || !Object.hasOwn(POD_PATHS, kind)) return null;
  const base = POD_PATHS[kind];
  const template = map(get(js, base));
  return { base, path: [...base, 'spec'], spec: map(template.spec), labels: map(map(template.metadata).labels) };
}

function containersOf(pod) {
  const list = [];
  for (const field of ['initContainers', 'containers']) {
    arr(pod.spec[field]).forEach((c, i) => list.push({ c: map(c), path: [...pod.path, field, i], init: field === 'initContainers' }));
  }
  return list;
}

// ---------- templates ----------

const scalarText = (value) => (AMBIGUOUS.test(value) ? JSON.stringify(value) : value);

function containerTemplate(indent, name, image, extra) {
  const lines = [
    `- name: ${scalarText(name)}`,
    `  image: ${image}`,
    ...extra,
    '  resources:',
    '    requests:',
    '      cpu: 100m',
    '      memory: 128Mi',
    '    limits:',
    '      memory: 256Mi',
    '  securityContext:',
    '    allowPrivilegeEscalation: false',
    '    capabilities:',
    '      drop: ["ALL"]',
  ];
  return lines.map((l) => ' '.repeat(indent) + l).join('\n');
}

function buildTemplate(kind, name) {
  const n = scalarText(name);
  const short = name.replace(/\./g, '-').slice(0, 63).replace(/-+$/, '');
  const head = `apiVersion: ${API_VERSIONS[kind]}\nkind: ${kind}\nmetadata:\n  name: ${n}\n`;
  const label = `app.kubernetes.io/name: ${scalarText(short)}`;
  const web = (indent) => containerTemplate(indent, short, 'nginxinc/nginx-unprivileged:1.27-alpine', [
    '  ports:', '    - name: http', '      containerPort: 8080',
  ]);
  const task = (indent) => containerTemplate(indent, short, 'busybox:1.36', ['  command: ["sh", "-c", "date"]']);
  const workload = (serviceName) => `${head}spec:
${serviceName ? `  serviceName: ${n}\n` : ''}  replicas: 2
  selector:
    matchLabels:
      ${label}
  template:
    metadata:
      labels:
        ${label}
    spec:
      securityContext:
        runAsNonRoot: true
      containers:
${web(8)}
`;
  const jobSpec = (indent) => {
    const body = `template:
  metadata:
    labels:
      ${label}
  spec:
    restartPolicy: Never
    securityContext:
      runAsNonRoot: true
      runAsUser: 65534
    containers:
${task(6)}`;
    return body.split('\n').map((l) => ' '.repeat(indent) + l).join('\n');
  };

  switch (kind) {
    case 'Deployment': return workload(false);
    case 'StatefulSet': return workload(true);
    case 'Job': return `${head}spec:\n  backoffLimit: 3\n${jobSpec(2)}\n`;
    case 'CronJob': return `${head}spec:\n  schedule: "0 3 * * *"\n  concurrencyPolicy: Forbid\n  jobTemplate:\n    spec:\n${jobSpec(6)}\n`;
    case 'Service': return `${head}spec:\n  type: ClusterIP\n  selector:\n    ${label}\n  ports:\n    - name: http\n      port: 80\n      targetPort: 8080\n`;
    case 'ConfigMap': return `${head}data:\n  LOG_LEVEL: info\n`;
    case 'Secret': return `${head}type: Opaque\ndata:\n  username: ${encodeBase64('app')}\n  password: ${encodeBase64('change-me')}\n`;
    case 'Ingress': return `${head}spec:\n  rules:\n    - host: app.example.com\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: ${n}\n                port:\n                  number: 80\n`;
    case 'Route': return `${head}spec:\n  to:\n    kind: Service\n    name: ${n}\n  port:\n    targetPort: 8080\n  tls:\n    termination: edge\n    insecureEdgeTerminationPolicy: Redirect\n`;
    default: return `${head}spec:\n  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 1Gi\n`;
  }
}

function template(kind, { name } = {}) {
  if (!KINDS.includes(kind)) fail('k8s.err.kind', { kind: clip(kind) });
  const actual = name || 'app';
  if (!validName(kind, actual)) fail('k8s.err.name', { kind, name: clip(actual) });
  return buildTemplate(kind, actual);
}

// ---------- factory ----------

export function createK8s(YAML) {
  const PARSE = { uniqueKeys: false, merge: true, prettyErrors: false, logLevel: 'error' };

  // ----- loading -----

  /** Splits at document markers; "---" and "..." in column 0 always end a document in YAML. */
  function split(text) {
    const segments = [];
    let current = { start: 0, lines: [] };
    const close = (end) => {
      if (end > current.start) segments.push({ ...current, end });
      current = { start: end, lines: [] };
    };
    let pos = 0;
    while (pos < text.length) {
      const newline = text.indexOf('\n', pos);
      const next = newline < 0 ? text.length : newline + 1;
      const line = text.slice(pos, newline < 0 ? text.length : newline);
      if (/^---([ \t]|$)/.test(line)) close(pos);
      current.lines.push({ start: pos, line });
      if (/^\.\.\.([ \t]|$)/.test(line)) close(next);
      pos = next;
    }
    close(text.length);
    for (const segment of segments) {
      const first = segment.lines.find(({ line }) => !/^\s*(#.*)?$/.test(line) && !/^%/.test(line)
        && !/^(---|\.\.\.)[ \t]*(#.*)?$/.test(line));
      segment.bodyStart = first ? first.start : null;
      const last = segment.lines.at(-1);
      segment.bodyEnd = /^\.\.\.([ \t]|$)/.test(last.line) ? last.start : segment.end;
    }
    return segments;
  }

  function parseBody(body) {
    const info = { yaml: null, errors: [], warnings: [], js: undefined, aliasProblem: false };
    try {
      const doc = YAML.parseDocument(body, PARSE);
      info.yaml = doc;
      info.errors = doc.errors.map((e) => ({ offset: e.pos?.[0] ?? 0, detail: e.message.split('\n')[0] }));
      info.warnings = doc.warnings.map((e) => ({ offset: e.pos?.[0] ?? 0, detail: e.message.split('\n')[0] }));
      if (info.errors.length) return info;

      let aliases = 0;
      YAML.visit(doc, {
        Alias: () => { aliases += 1; },
        Map: (_, node) => {
          const seen = new Set();
          for (const pair of node.items) {
            const key = YAML.isScalar(pair.key) ? str(pair.key.value) : null;
            if (key === null || key === '<<') continue;
            if (seen.has(key)) info.errors.push({ offset: pair.key.range?.[0] ?? 0, key: clip(key), detail: `Duplicate key "${clip(key)}"` });
            seen.add(key);
          }
        },
      });
      if (info.errors.length) return info;
      if (aliases > MAX_ALIASES) info.aliasProblem = true;
      else {
        try {
          info.js = doc.toJS({ maxAliasCount: MAX_ALIASES });
        } catch {
          info.aliasProblem = true;
        }
      }
    } catch (e) {
      // Pathological nesting can overflow the stack inside the library.
      info.errors.push({ offset: 0, detail: e instanceof RangeError ? 'The document is nested too deeply' : String(e.message).split('\n')[0] });
    }
    return info;
  }

  function load(input) {
    const source = String(input ?? '');
    const bom = source.startsWith('﻿') ? '﻿' : '';
    const crlf = source.includes('\r\n');
    const text = source.slice(bom.length).replace(/\r\n/g, '\n');
    const state = { text, bom, eol: crlf ? '\r\n' : '\n', segments: [], docs: [], tooLarge: false, tooMany: false, starts: [0] };
    if (text.length > MAX_LENGTH) {
      state.tooLarge = true;
      return state;
    }
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) state.starts.push(i + 1);
    state.segments = split(text);
    const content = state.segments.filter((s) => s.bodyStart !== null);
    state.tooMany = content.length > MAX_DOCS;
    state.docs = content.slice(0, MAX_DOCS).map((segment, index) => ({
      index, segment, offset: segment.bodyStart, ...parseBody(text.slice(segment.bodyStart, segment.bodyEnd)),
    }));
    return state;
  }

  const lineAt = (state, offset) => {
    let low = 0;
    let high = state.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (state.starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const keyText = (key) => str(YAML.isScalar(key) ? key.value : key);
  const findPair = (node, key) => node.items.find((p) => keyText(p.key) === String(key));

  /** Line of the deepest node that exists along the path. */
  function lineOf(state, doc, path = []) {
    let node = doc.yaml?.contents;
    let offset = node?.range?.[0] ?? 0;
    for (const key of path) {
      if (YAML.isAlias(node)) node = node.resolve(doc.yaml);
      if (YAML.isMap(node)) {
        const pair = findPair(node, key);
        if (!pair) break;
        offset = pair.key?.range?.[0] ?? offset;
        node = pair.value;
      } else if (YAML.isSeq(node) && node.items[key]) {
        node = node.items[key];
        offset = node.range?.[0] ?? offset;
      } else break;
    }
    return lineAt(state, doc.offset + offset);
  }

  const identity = (doc) => {
    if (doc.js === undefined) {
      const body = doc.segment.lines.map((l) => l.line);
      const kind = body.map((l) => /^kind:[ \t]*([A-Za-z]+)/.exec(l)?.[1]).find(Boolean);
      return { kind: kind ?? null, apiVersion: null, name: null, namespace: null };
    }
    const js = map(doc.js);
    const meta = map(js.metadata);
    return { kind: str(js.kind), apiVersion: str(js.apiVersion), name: str(meta.name) ?? str(meta.generateName), namespace: str(meta.namespace) };
  };

  function parse(text) {
    const state = load(text);
    if (state.tooLarge) return { docs: [], errors: [{ line: 1, message: t('en', 'k8s.diag.tooLarge', { limit: MAX_LENGTH / 1024 }) }] };
    const errors = [];
    const docs = state.docs.map((doc) => {
      for (const e of doc.errors) errors.push({ line: lineAt(state, doc.offset + e.offset), message: e.detail });
      if (doc.aliasProblem) errors.push({ line: lineAt(state, doc.offset), message: t('en', 'k8s.diag.aliases') });
      return { index: doc.index, ...identity(doc), line: lineAt(state, doc.offset) };
    });
    if (state.tooMany) errors.push({ line: 1, message: t('en', 'k8s.diag.tooManyDocs', { limit: MAX_DOCS }) });
    return { docs, errors };
  }

  // ----- file-wide index used by checks and the summary -----

  function index(state) {
    const objects = new Map(); // kind -> name -> [{ doc, js, namespace }]
    const workloads = [];
    for (const doc of state.docs) {
      const kind = knownKind(doc.js);
      if (!kind) continue;
      const meta = map(doc.js.metadata);
      const name = str(meta.name);
      const namespace = str(meta.namespace);
      if (name !== null) {
        if (!objects.has(kind)) objects.set(kind, new Map());
        if (!objects.get(kind).has(name)) objects.get(kind).set(name, []);
        objects.get(kind).get(name).push({ doc: doc.index, js: doc.js, namespace });
      }
      const pod = podInfo(doc.js);
      if (!pod) continue;
      const ports = containersOf(pod).filter((c) => !c.init).flatMap((c) => arr(c.c.ports).map(map));
      workloads.push({
        doc: doc.index, kind, name, namespace, labels: pod.labels,
        portNames: new Set(ports.map((p) => str(p.name))), portNumbers: new Set(ports.map((p) => p.containerPort)),
      });
    }
    const sameNamespace = (a, b) => !a || !b || a === b;
    return {
      workloads,
      sameNamespace,
      find: (kind, name, namespace) => objects.get(kind)?.get(name)?.find((o) => sameNamespace(o.namespace, namespace)) ?? null,
      select: (selector, namespace) => {
        const wanted = entries(selector);
        if (!wanted.length) return [];
        return workloads.filter((w) => sameNamespace(w.namespace, namespace)
          && wanted.every(([k, v]) => Object.hasOwn(w.labels, k) && str(w.labels[k]) === str(v)));
      },
    };
  }

  /** ConfigMap / Secret / PVC names a pod spec refers to. */
  function references(pod) {
    const refs = [];
    const add = (kind, name, path, extra = {}) => {
      if (str(name)) refs.push({ kind, name: str(name), path, ...extra });
    };
    for (const { c, path } of containersOf(pod)) {
      arr(c.env).forEach((e, i) => {
        for (const [field, kind] of [['configMapKeyRef', 'ConfigMap'], ['secretKeyRef', 'Secret']]) {
          const ref = map(map(map(e).valueFrom)[field]);
          add(kind, ref.name, [...path, 'env', i, 'valueFrom', field, 'name'], { key: str(ref.key), optional: ref.optional === true });
        }
      });
      arr(c.envFrom).forEach((e, i) => {
        for (const [field, kind] of [['configMapRef', 'ConfigMap'], ['secretRef', 'Secret']]) {
          const ref = map(map(e)[field]);
          add(kind, ref.name, [...path, 'envFrom', i, field, 'name'], { optional: ref.optional === true });
        }
      });
    }
    arr(pod.spec.volumes).forEach((raw, i) => {
      const volume = map(raw);
      const path = [...pod.path, 'volumes', i];
      add('ConfigMap', map(volume.configMap).name, [...path, 'configMap', 'name'], { optional: map(volume.configMap).optional === true });
      add('Secret', map(volume.secret).secretName, [...path, 'secret', 'secretName'], { optional: map(volume.secret).optional === true });
      add('PersistentVolumeClaim', map(volume.persistentVolumeClaim).claimName, [...path, 'persistentVolumeClaim', 'claimName']);
      for (const source of arr(map(volume.projected).sources)) {
        add('ConfigMap', map(map(source).configMap).name, [...path, 'projected'], { optional: map(map(source).configMap).optional === true });
        add('Secret', map(map(source).secret).name, [...path, 'projected'], { optional: map(map(source).secret).optional === true });
      }
    });
    arr(pod.spec.imagePullSecrets).forEach((s, i) => add('Secret', map(s).name, [...pod.path, 'imagePullSecrets', i, 'name']));
    return refs;
  }

  // ----- validation -----

  function validate(text, { lang = 'en', image = null } = {}) {
    const state = load(text);
    const out = [];
    const push = (severity, line, doc, code, key, params) => out.push({ severity, line, doc, code, message: t(lang, key, params) });
    if (state.tooLarge) {
      push('error', 1, 0, 'too-large', 'k8s.diag.tooLarge', { limit: MAX_LENGTH / 1024 });
      return out;
    }
    if (state.tooMany) push('error', 1, 0, 'too-many-docs', 'k8s.diag.tooManyDocs', { limit: MAX_DOCS });

    const idx = index(state);
    const seen = new Set();
    for (const doc of state.docs) {
      let count = 0;
      const at = (severity, path, code, key, params) => {
        if (count++ < MAX_DIAGNOSTICS_PER_DOC) push(severity, lineOf(state, doc, path), doc.index, code, key, params);
      };
      const raw = (severity, offset, code, key, params) => {
        if (count++ < MAX_DIAGNOSTICS_PER_DOC) push(severity, lineAt(state, doc.offset + offset), doc.index, code, key, params);
      };
      // Later syntax errors are mostly noise caused by the first one.
      for (const e of doc.errors.slice(0, 5)) {
        if (e.key !== undefined) raw('error', e.offset, 'duplicate-key', 'k8s.diag.duplicateKey', { key: e.key });
        else raw('error', e.offset, 'syntax', 'k8s.diag.syntax', { detail: e.detail });
      }
      if (doc.errors.length) continue;
      for (const w of doc.warnings) raw('warning', w.offset, 'yaml', 'k8s.diag.yamlWarning', { detail: w.detail });
      if (doc.aliasProblem) {
        raw('error', 0, 'aliases', 'k8s.diag.aliases');
        continue;
      }
      checkObject({ doc, js: doc.js, idx, seen, image, lang, at });
    }

    const rank = { error: 0, warning: 1, info: 2 };
    return out.sort((a, b) => a.line - b.line || rank[a.severity] - rank[b.severity]);
  }

  function checkObject(ctx) {
    const { js, at, seen } = ctx;
    const error = (path, code, key, params) => at('error', path, code, key, params);
    if (!isMap(js)) return error([], 'not-object', 'k8s.diag.notObject');
    const kind = str(js.kind);
    if (!kind) return error(['kind'], 'kind', 'k8s.diag.required', { field: 'kind' });
    if (!knownKind(js)) return at('info', ['kind'], 'unsupported-kind', 'k8s.diag.unsupported', { kind: clip(kind) });

    const apiVersion = str(js.apiVersion);
    if (!apiVersion) error(['apiVersion'], 'api-version', 'k8s.diag.required', { field: 'apiVersion' });
    else if (apiVersion !== API_VERSIONS[kind]) {
      error(['apiVersion'], 'api-version', 'k8s.diag.apiVersion', { kind, expected: API_VERSIONS[kind], value: clip(apiVersion) });
    }

    const meta = map(js.metadata);
    const name = str(meta.name);
    if (!name) {
      if (!(kind === 'Job' && str(meta.generateName))) error(['metadata', 'name'], 'name', 'k8s.diag.required', { field: 'metadata.name' });
    } else {
      if (typeof meta.name !== 'string' || !validName(kind, name)) {
        error(['metadata', 'name'], 'name', 'k8s.diag.name', { field: 'metadata.name', value: clip(name) });
      }
      const identityKey = JSON.stringify([kind, str(meta.namespace), name]);
      if (seen.has(identityKey)) error(['metadata', 'name'], 'duplicate-object', 'k8s.diag.duplicateObject', { kind, name: clip(name) });
      seen.add(identityKey);
    }
    const namespace = str(meta.namespace);
    if (namespace !== null && (namespace.length > 63 || !DNS_LABEL.test(namespace))) {
      error(['metadata', 'namespace'], 'name', 'k8s.diag.name', { field: 'metadata.namespace', value: clip(namespace) });
    }
    ctx.kind = kind;
    ctx.namespace = namespace;

    if (!['ConfigMap', 'Secret'].includes(kind) && !isMap(js.spec)) return error(['spec'], 'spec', 'k8s.diag.required', { field: 'spec' });
    if (Object.hasOwn(POD_PATHS, kind)) checkWorkload(ctx);
    else if (kind === 'Service') checkService(ctx);
    else if (kind === 'ConfigMap' || kind === 'Secret') checkData(ctx);
    else if (kind === 'Ingress') checkIngress(ctx);
    else if (kind === 'Route') checkRoute(ctx);
    else checkClaim(ctx);
    return undefined;
  }

  function reference(ctx, kind, name, path, { key = null, optional = false } = {}) {
    const found = ctx.idx.find(kind, name, ctx.namespace);
    if (!found) {
      if (!optional) ctx.at('info', path, 'ref-external', 'k8s.diag.refExternal', { kind, name: clip(name) });
      return null;
    }
    if (key !== null && !optional) {
      const has = ['data', 'stringData', 'binaryData'].some((f) => Object.hasOwn(map(found.js[f]), key));
      if (!has) ctx.at('warning', path, 'missing-key', 'k8s.diag.missingKey', { kind, name: clip(name), key: clip(key) });
    }
    return found;
  }

  function checkWorkload(ctx) {
    const { js, kind, at } = ctx;
    const error = (path, code, key, params) => at('error', path, code, key, params);
    const spec = map(js.spec);
    const pod = podInfo(js);

    if (kind === 'Deployment' || kind === 'StatefulSet') {
      const match = map(map(spec.selector).matchLabels);
      const expressions = arr(map(spec.selector).matchExpressions);
      if (!entries(match).length && !expressions.length) error(['spec', 'selector'], 'selector-missing', 'k8s.diag.selectorMissing');
      for (const [k, v] of entries(match)) {
        if (!Object.hasOwn(pod.labels, k) || str(pod.labels[k]) !== str(v)) {
          error(['spec', 'selector', 'matchLabels', k], 'selector-mismatch', 'k8s.diag.selectorMismatch', { label: `${clip(k)}=${clip(v)}` });
        }
      }
      if (spec.replicas !== undefined && !(Number.isInteger(spec.replicas) && spec.replicas >= 0)) {
        error(['spec', 'replicas'], 'type', 'k8s.diag.type', { field: 'spec.replicas', expected: 'integer >= 0' });
      }
      const policy = pod.spec.restartPolicy;
      if (policy !== undefined && policy !== 'Always') error([...pod.path, 'restartPolicy'], 'restart-policy', 'k8s.diag.restartPolicyAlways');
      if (kind === 'StatefulSet' && str(spec.serviceName)) reference(ctx, 'Service', str(spec.serviceName), ['spec', 'serviceName']);
    } else if (!['OnFailure', 'Never'].includes(pod.spec.restartPolicy)) {
      error([...pod.path, 'restartPolicy'], 'restart-policy', 'k8s.diag.restartPolicyJob');
    }

    if (kind === 'CronJob') {
      const schedule = str(spec.schedule);
      if (!schedule) error(['spec', 'schedule'], 'schedule', 'k8s.diag.required', { field: 'spec.schedule' });
      else if (!validSchedule(schedule)) error(['spec', 'schedule'], 'schedule', 'k8s.diag.schedule', { value: clip(schedule) });
    }

    checkPod(ctx, pod);
  }

  function checkPod(ctx, pod) {
    const { at, image } = ctx;
    const error = (path, code, key, params) => at('error', path, code, key, params);
    const warn = (path, code, key, params) => at('warning', path, code, key, params);
    if (!arr(pod.spec.containers).length) error([...pod.path, 'containers'], 'containers', 'k8s.diag.required', { field: 'containers' });
    for (const field of ['containers', 'initContainers', 'volumes']) {
      if (pod.spec[field] !== undefined && pod.spec[field] !== null && !Array.isArray(pod.spec[field])) {
        error([...pod.path, field], 'type', 'k8s.diag.type', { field, expected: 'list' });
      }
    }

    const volumes = new Set([
      ...arr(pod.spec.volumes).map((v) => str(map(v).name)),
      ...arr(map(ctx.js.spec).volumeClaimTemplates).map((v) => str(map(map(v).metadata).name)),
    ]);
    const names = new Set();
    const portNames = new Set();
    const declared = new Set();
    const containers = containersOf(pod);
    const podSecurity = map(pod.spec.securityContext);

    for (const { c, path, init } of containers) {
      const name = str(c.name);
      const shown = clip(name ?? '?');
      if (!name) error([...path, 'name'], 'container-name', 'k8s.diag.required', { field: 'name' });
      else {
        if (name.length > 63 || !DNS_LABEL.test(name)) error([...path, 'name'], 'container-name', 'k8s.diag.name', { field: 'name', value: shown });
        if (names.has(name)) error([...path, 'name'], 'duplicate-name', 'k8s.diag.duplicateName', { name: shown });
        names.add(name);
      }

      checkImage(ctx, c, path);

      if (c.ports !== undefined && c.ports !== null && !Array.isArray(c.ports)) error([...path, 'ports'], 'type', 'k8s.diag.type', { field: 'ports', expected: 'list' });
      arr(c.ports).forEach((raw, i) => {
        const port = map(raw);
        const where = [...path, 'ports', i];
        if (!isPort(port.containerPort)) error([...where, 'containerPort'], 'port-range', 'k8s.diag.port', { field: 'containerPort', value: clip(port.containerPort) });
        else if (!init) declared.add(`${port.containerPort}/${(str(port.protocol) ?? 'TCP').toLowerCase()}`);
        if (port.name !== undefined) {
          const portName = str(port.name) ?? '';
          if (portName.length > 15 || !DNS_LABEL.test(portName) || !/[a-z]/.test(portName)) {
            error([...where, 'name'], 'port-name', 'k8s.diag.portName', { value: clip(portName) });
          }
          if (portNames.has(portName)) error([...where, 'name'], 'duplicate-name', 'k8s.diag.duplicateName', { name: clip(portName) });
          portNames.add(portName);
        }
        if (port.protocol !== undefined && !['TCP', 'UDP', 'SCTP'].includes(port.protocol)) {
          error([...where, 'protocol'], 'protocol', 'k8s.diag.protocol', { value: clip(port.protocol) });
        }
      });

      checkResources(ctx, c, path, shown, init);

      const security = map(c.securityContext);
      if (security.privileged === true) warn([...path, 'securityContext', 'privileged'], 'privileged', 'k8s.diag.privileged', { name: shown });
      const nonRoot = security.runAsNonRoot ?? podSecurity.runAsNonRoot;
      const uid = security.runAsUser ?? podSecurity.runAsUser;
      if (nonRoot === true && uid === 0) error([...path, 'securityContext'], 'root-uid', 'k8s.diag.rootUid');
      else if (nonRoot !== true && !(Number.isInteger(uid) && uid > 0)) warn(path, 'run-as-non-root', 'k8s.diag.runAsNonRoot', { name: shown });

      checkEnv(ctx, c, path);

      arr(c.volumeMounts).forEach((m, i) => {
        const volume = str(map(m).name);
        if (volume && !volumes.has(volume)) error([...path, 'volumeMounts', i, 'name'], 'volume-mount', 'k8s.diag.volumeMissing', { name: clip(volume) });
      });

      if (image && !init) checkLinkedContainer(ctx, c, path, nonRoot, uid);
    }

    for (const ref of references(pod)) reference(ctx, ref.kind, ref.name, ref.path, ref);
    if (image) checkExposed(ctx, pod, declared);
  }

  function checkImage(ctx, c, path) {
    const value = str(c.image);
    if (!value) return ctx.at('error', [...path, 'image'], 'image', 'k8s.diag.required', { field: 'image' });
    // Values filled in later by templating tools cannot be checked.
    if (value.includes('{{') || value.includes('$')) return undefined;
    const ref = value.length > 500 ? { ok: false, key: 'ref.repo', params: { value: clip(value) } } : parseImageRef(value);
    if (!ref.ok) {
      ctx.at('error', [...path, 'image'], 'image-invalid', 'k8s.diag.imageInvalid', { value: clip(value), detail: translate(ctx.lang, ref.key, ref.params) });
    } else if (!ref.digest && ref.tag === 'latest') {
      ctx.at('warning', [...path, 'image'], 'image-latest', 'k8s.diag.imageLatest', { value: clip(value) });
    }
    return undefined;
  }

  function checkResources(ctx, c, path, shown, init) {
    const resources = map(c.resources);
    const requests = map(resources.requests);
    const limits = map(resources.limits);
    if (!init) {
      if (!entries(requests).length) ctx.at('warning', [...path, 'resources'], 'no-requests', 'k8s.diag.noRequests', { name: shown });
      if (!entries(limits).length) ctx.at('warning', [...path, 'resources'], 'no-limits', 'k8s.diag.noLimits', { name: shown });
    }
    for (const [group, list] of [['requests', requests], ['limits', limits]]) {
      for (const [resource, value] of entries(list)) {
        if (quantity(value) === null) {
          ctx.at('error', [...path, 'resources', group, resource], 'quantity', 'k8s.diag.quantity', { field: `${group}.${clip(resource)}`, value: clip(value) });
        }
      }
    }
    for (const [resource, value] of entries(requests)) {
      const request = quantity(value);
      const limit = Object.hasOwn(limits, resource) ? quantity(limits[resource]) : null;
      if (request !== null && limit !== null && request > limit) {
        ctx.at('error', [...path, 'resources', 'requests', resource], 'request-over-limit', 'k8s.diag.requestOverLimit', { resource: clip(resource) });
      }
    }
  }

  function checkEnv(ctx, c, path) {
    const { at } = ctx;
    if (c.env !== undefined && c.env !== null && !Array.isArray(c.env)) at('error', [...path, 'env'], 'type', 'k8s.diag.type', { field: 'env', expected: 'list' });
    const seen = new Set();
    arr(c.env).forEach((raw, i) => {
      const env = map(raw);
      const where = [...path, 'env', i];
      const name = str(env.name);
      if (!name) return at('error', where, 'env-name', 'k8s.diag.required', { field: 'env.name' });
      const shown = clip(name);
      if (seen.has(name)) at('warning', where, 'duplicate-env', 'k8s.diag.duplicateEnv', { name: shown });
      seen.add(name);
      const has = Object.hasOwn(env, 'value');
      const from = Object.hasOwn(env, 'valueFrom');
      if (has && from) at('error', where, 'env-value', 'k8s.diag.envBoth', { name: shown });
      else if (!has && !from) at('warning', where, 'env-value', 'k8s.diag.envNoValue', { name: shown });
      if (has && typeof env.value !== 'string') at('error', [...where, 'value'], 'env-type', 'k8s.diag.notString', { field: `env ${shown}` });
      if (typeof env.value === 'string' && env.value !== '' && plainSecret(name, env.value)) {
        at('warning', [...where, 'value'], 'plain-secret', 'k8s.diag.plainSecret', { name: shown });
      }
      return undefined;
    });
  }

  function plainSecret(name, value) {
    if (value.includes('$(') || value.includes('{{')) return false;
    if (URL_CREDENTIALS.test(value.slice(0, 2000))) return true;
    return SECRET_NAME.test(name) && !NOT_A_SECRET.test(name) && !/^(true|false|\d{1,6})$/i.test(value);
  }

  // ----- linked Dockerfile -----

  function exposedPorts(image) {
    const ports = [];
    for (const entry of arr(image.expose)) {
      const m = /^(\d+)(?:-(\d+))?(?:\/(\w+))?$/.exec(str(entry) ?? '');
      if (!m) continue;
      ports.push({ from: Number(m[1]), to: Number(m[2] ?? m[1]), protocol: (m[3] ?? 'tcp').toLowerCase(), text: str(entry) });
    }
    return ports;
  }

  function checkLinkedContainer(ctx, c, path, nonRoot, uid) {
    const { image, at } = ctx;
    const exposed = exposedPorts(image);
    arr(c.ports).forEach((raw, i) => {
      const port = map(raw);
      if (!isPort(port.containerPort)) return;
      const protocol = (str(port.protocol) ?? 'TCP').toLowerCase();
      if (exposed.some((e) => e.protocol === protocol && port.containerPort >= e.from && port.containerPort <= e.to)) return;
      // With nothing declared there is nothing to contradict, so only hint.
      at(exposed.length ? 'warning' : 'info', [...path, 'ports', i, 'containerPort'], 'port-not-exposed', 'k8s.diag.portNotExposed', { port: `${port.containerPort}/${protocol}` });
    });

    // An explicit runAsUser overrides whatever the image says.
    if (nonRoot === true && uid === undefined) {
      const where = [...path, 'securityContext'];
      const user = str(image.user);
      const id = (user ?? '').split(':')[0];
      if (!id) {
        if (image.known === false) at('warning', where, 'image-user', 'k8s.diag.userUnknownBase');
        else at('error', where, 'image-user', 'k8s.diag.userRoot', { user: 'root' });
      } else if (id === 'root' || /^0+$/.test(id)) at('error', where, 'image-user', 'k8s.diag.userRoot', { user: clip(user) });
      else if (!/^\d+$/.test(id)) at('warning', where, 'image-user-name', 'k8s.diag.userName', { user: clip(user) });
    }

    if (c.command !== undefined && c.command !== null) at('info', [...path, 'command'], 'command-override', 'k8s.diag.commandOverride');
    if (c.args !== undefined && c.args !== null) at('info', [...path, 'args'], 'args-override', 'k8s.diag.argsOverride');
  }

  function checkExposed(ctx, pod, declared) {
    // Batch pods do not usually serve traffic.
    if (ctx.kind === 'Job' || ctx.kind === 'CronJob') return;
    for (const e of exposedPorts(ctx.image)) {
      const used = [...declared].some((d) => {
        const [port, protocol] = d.split('/');
        return protocol === e.protocol && Number(port) >= e.from && Number(port) <= e.to;
      });
      if (!used) ctx.at('info', [...pod.path, 'containers'], 'expose-unused', 'k8s.diag.exposeUnused', { port: clip(e.text) });
    }
  }

  // ----- other kinds -----

  function checkService(ctx) {
    const { js, at, idx } = ctx;
    const error = (path, code, key, params) => at('error', path, code, key, params);
    const spec = map(js.spec);
    const type = spec.type ?? 'ClusterIP';
    if (!['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(type)) {
      error(['spec', 'type'], 'service-type', 'k8s.diag.serviceType', { value: clip(type) });
    }
    if (type === 'ExternalName') {
      if (!str(spec.externalName)) error(['spec', 'externalName'], 'external-name', 'k8s.diag.required', { field: 'spec.externalName' });
      return;
    }
    const ports = arr(spec.ports).map(map);
    if (!ports.length && spec.clusterIP !== 'None') error(['spec', 'ports'], 'service-ports', 'k8s.diag.serviceNoPorts');

    const selected = idx.select(spec.selector, ctx.namespace);
    if (entries(spec.selector).length && !selected.length) {
      const params = { selector: clip(selectorText(spec.selector)) };
      if (idx.workloads.length) at('warning', ['spec', 'selector'], 'selector-no-match', 'k8s.diag.selectorNoMatch', params);
      else at('info', ['spec', 'selector'], 'selector-external', 'k8s.diag.selectorExternal', params);
    }

    const names = new Set();
    ports.forEach((port, i) => {
      const where = ['spec', 'ports', i];
      if (!isPort(port.port)) error([...where, 'port'], 'port-range', 'k8s.diag.port', { field: 'port', value: clip(port.port) });
      const name = str(port.name);
      if (!name && ports.length > 1) error(where, 'service-port-name', 'k8s.diag.servicePortName');
      if (name) {
        if (names.has(name)) error([...where, 'name'], 'duplicate-name', 'k8s.diag.duplicateName', { name: clip(name) });
        names.add(name);
      }
      if (port.protocol !== undefined && !['TCP', 'UDP', 'SCTP'].includes(port.protocol)) {
        error([...where, 'protocol'], 'protocol', 'k8s.diag.protocol', { value: clip(port.protocol) });
      }
      if (port.nodePort !== undefined && !(port.nodePort >= 30000 && port.nodePort <= 32767)) {
        at('warning', [...where, 'nodePort'], 'node-port', 'k8s.diag.nodePort', { value: clip(port.nodePort) });
      }
      const target = port.targetPort ?? port.port;
      if (typeof target === 'number') {
        if (!isPort(target)) error([...where, 'targetPort'], 'port-range', 'k8s.diag.port', { field: 'targetPort', value: clip(target) });
        else if (selected.length && selected.every((w) => w.portNumbers.size && !w.portNumbers.has(target))) {
          at('info', [...where, 'targetPort'], 'target-port', 'k8s.diag.targetPortUndeclared', { value: target });
        }
      } else if (selected.length && !selected.some((w) => w.portNames.has(str(target)))) {
        at('warning', [...where, 'targetPort'], 'target-port', 'k8s.diag.targetPortName', { value: clip(target) });
      }
    });
  }

  function checkData(ctx) {
    const { js, kind, at } = ctx;
    for (const field of ['data', 'stringData', 'binaryData']) {
      if (js[field] === undefined || js[field] === null) continue;
      if (!isMap(js[field])) {
        at('error', [field], 'type', 'k8s.diag.type', { field, expected: 'mapping' });
        continue;
      }
      for (const [key, value] of entries(js[field])) {
        const path = [field, key];
        if (key.length > 253 || !DATA_KEY.test(key)) at('error', path, 'data-key', 'k8s.diag.dataKey', { key: clip(key) });
        if (typeof value !== 'string') {
          at('error', path, 'data-type', 'k8s.diag.notString', { field: `${field}.${clip(key)}` });
        } else if (field === 'binaryData' || (kind === 'Secret' && field === 'data')) {
          if (!decodeBase64(value).valid) at('error', path, 'base64', 'k8s.diag.base64', { key: clip(key) });
        } else if (kind === 'ConfigMap' && value !== '' && plainSecret(key, value)) {
          at('warning', path, 'plain-secret', 'k8s.diag.plainSecret', { name: clip(key) });
        }
      }
    }
  }

  /** A backend / target port must exist on the Service when the Service is in the file. */
  function servicePorts(found) {
    return arr(map(found.js.spec).ports).map(map);
  }

  function checkIngress(ctx) {
    const { js, at } = ctx;
    const error = (path, code, key, params) => at('error', path, code, key, params);
    const spec = map(js.spec);
    for (const tls of arr(spec.tls)) {
      if (str(map(tls).secretName)) reference(ctx, 'Secret', str(map(tls).secretName), ['spec', 'tls']);
    }
    const backend = (value, path) => {
      const service = map(map(value).service);
      const name = str(service.name);
      if (!name) {
        if (!isMap(map(value).resource)) error(path, 'backend', 'k8s.diag.required', { field: 'backend.service.name' });
        return;
      }
      const port = map(service.port);
      const wanted = port.number ?? port.name;
      if (wanted === undefined) error([...path, 'service'], 'backend', 'k8s.diag.required', { field: 'backend.service.port' });
      else if (port.number !== undefined && !isPort(port.number)) {
        error([...path, 'service', 'port', 'number'], 'port-range', 'k8s.diag.port', { field: 'port.number', value: clip(port.number) });
      }
      const found = reference(ctx, 'Service', name, [...path, 'service', 'name']);
      if (!found || wanted === undefined) return;
      const ok = servicePorts(found).some((p) => (port.number !== undefined ? p.port === port.number : p.name === port.name));
      if (!ok) error([...path, 'service', 'port'], 'backend-port', 'k8s.diag.backendPort', { name: clip(name), port: clip(wanted) });
    };

    const rules = arr(spec.rules);
    if (!rules.length && !spec.defaultBackend) error(['spec'], 'rules', 'k8s.diag.noRules');
    if (spec.defaultBackend) backend(spec.defaultBackend, ['spec', 'defaultBackend']);
    rules.forEach((rule, i) => {
      const paths = arr(map(map(rule).http).paths);
      paths.forEach((raw, j) => {
        const entry = map(raw);
        const where = ['spec', 'rules', i, 'http', 'paths', j];
        if (!['Prefix', 'Exact', 'ImplementationSpecific'].includes(entry.pathType)) error([...where, 'pathType'], 'path-type', 'k8s.diag.pathType');
        const path = str(entry.path);
        if (entry.pathType !== 'ImplementationSpecific' && !path?.startsWith('/')) {
          error([...where, 'path'], 'path', 'k8s.diag.pathSlash', { value: clip(path ?? '') });
        }
        backend(entry.backend, [...where, 'backend']);
      });
    });
  }

  function checkRoute(ctx) {
    const { js, at } = ctx;
    const error = (path, code, key, params) => at('error', path, code, key, params);
    const spec = map(js.spec);
    const to = map(spec.to);
    const name = str(to.name);
    const termination = map(spec.tls).termination;
    if (spec.tls && !['edge', 'passthrough', 'reencrypt'].includes(termination)) {
      error(['spec', 'tls', 'termination'], 'termination', 'k8s.diag.termination', { value: clip(termination) });
    }
    if (to.kind !== undefined && to.kind !== 'Service') error(['spec', 'to', 'kind'], 'route-target', 'k8s.diag.routeTarget');
    if (!name) return error(['spec', 'to', 'name'], 'backend', 'k8s.diag.required', { field: 'spec.to.name' });
    const found = reference(ctx, 'Service', name, ['spec', 'to', 'name']);
    const wanted = map(spec.port).targetPort;
    if (!found || wanted === undefined) return undefined;
    const ok = servicePorts(found).some((p) => (typeof wanted === 'number' ? (p.targetPort ?? p.port) === wanted : p.name === wanted || p.targetPort === wanted));
    if (!ok) at('warning', ['spec', 'port', 'targetPort'], 'backend-port', 'k8s.diag.backendPort', { name: clip(name), port: clip(wanted) });
    return undefined;
  }

  function checkClaim(ctx) {
    const { js, at } = ctx;
    const spec = map(js.spec);
    const modes = arr(spec.accessModes);
    const allowed = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];
    if (!modes.length || !modes.every((m) => allowed.includes(m))) at('error', ['spec', 'accessModes'], 'access-modes', 'k8s.diag.accessModes');
    const storage = get(spec, ['resources', 'requests', 'storage']);
    const path = ['spec', 'resources', 'requests', 'storage'];
    if (storage === undefined || storage === null) at('error', path, 'storage', 'k8s.diag.required', { field: 'spec.resources.requests.storage' });
    else if (!(quantity(storage) > 0)) at('error', path, 'quantity', 'k8s.diag.quantity', { field: 'storage', value: clip(storage) });
  }

  // ----- form model -----

  function form(text, docIndex) {
    const doc = load(text).docs[docIndex];
    if (!doc || !isMap(doc.js)) return { kind: doc ? identity(doc).kind : null, groups: [] };
    const js = doc.js;
    const kind = knownKind(js);
    const groups = [];

    const group = (id, labelKey, fields, add, label) => {
      const entry = { id, labelKey, fields };
      if (add) entry.add = add;
      if (label !== undefined) entry.label = label;
      groups.push(entry);
    };
    const field = (path, labelKey, type, fallback = '', extra = {}) => {
      const current = get(js, path);
      let value;
      if (type === 'boolean') value = typeof current === 'boolean' ? current : fallback === true;
      else if (type === 'number' && typeof current === 'number') value = current;
      else value = str(current) ?? (current === undefined || current === null ? str(fallback) ?? '' : '');
      const shownType = type === 'number' && typeof value === 'string' && value !== '' ? 'string'
        : type === 'string' && typeof value === 'string' && value.includes('\n') ? 'text' : type;
      return { path, labelKey, label: String(path.at(-1)), type: shownType, value, ...extra };
    };
    const select = (path, labelKey, options) => {
      const f = field(path, labelKey, 'select');
      f.options = options.includes(f.value) ? options : [...options, f.value];
      return f;
    };
    const adder = (type, path, labelKey, inputs) => ({
      type, path, labelKey,
      inputs: inputs.map(([name, key, inputType = 'string']) => ({ name, labelKey: `k8s.field.${key}`, type: inputType })),
    });
    const mapFields = (base, extra = () => ({})) => entries(get(js, base)).map(([key]) => ({
      ...field([...base, key], null, 'string', '', { removable: true }), label: key, ...extra(key),
    }));

    group('metadata', 'k8s.group.metadata', [
      field(['metadata', 'name'], 'k8s.field.name', 'string'),
      field(['metadata', 'namespace'], 'k8s.field.namespace', 'string'),
    ]);
    if (!kind) return { kind: str(js.kind), groups };

    const pod = podInfo(js);
    if (pod) workloadForm();
    else if (kind === 'Service') {
      group('spec', 'k8s.group.spec', [select(['spec', 'type'], 'k8s.field.type', ['', 'ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'])]);
      group('selector', 'k8s.group.selector', mapFields(['spec', 'selector']),
        adder('selector', ['spec', 'selector'], 'k8s.group.addSelector', [['key', 'key'], ['value', 'value']]));
      const fields = arr(get(js, ['spec', 'ports'])).flatMap((_, i) => {
        const base = ['spec', 'ports', i];
        return [
          field([...base, 'port'], 'k8s.field.port', 'number', '', { removable: true }),
          field([...base, 'targetPort'], 'k8s.field.targetPort', 'string'),
          field([...base, 'name'], 'k8s.field.portName', 'string'),
          select([...base, 'protocol'], 'k8s.field.protocol', ['', 'TCP', 'UDP', 'SCTP']),
        ];
      });
      group('ports', 'k8s.group.ports', fields, adder('servicePort', ['spec', 'ports'], 'k8s.group.addPort',
        [['port', 'port', 'number'], ['targetPort', 'targetPort'], ['name', 'portName']]));
    } else if (kind === 'ConfigMap' || kind === 'Secret') {
      dataForm();
    } else if (kind === 'Ingress') {
      ingressForm();
    } else if (kind === 'Route') {
      group('spec', 'k8s.group.spec', [
        field(['spec', 'host'], 'k8s.field.host', 'string'),
        field(['spec', 'to', 'name'], 'k8s.field.routeService', 'string'),
        field(['spec', 'port', 'targetPort'], 'k8s.field.targetPort', 'string'),
        select(['spec', 'tls', 'termination'], 'k8s.field.termination', ['', 'edge', 'passthrough', 'reencrypt']),
      ]);
    } else {
      group('spec', 'k8s.group.spec', [
        field(['spec', 'storageClassName'], 'k8s.field.storageClassName', 'string'),
        select(['spec', 'accessModes', 0], 'k8s.field.accessMode', ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod']),
        field(['spec', 'resources', 'requests', 'storage'], 'k8s.field.storage', 'string'),
      ]);
    }
    return { kind, groups };

    function workloadForm() {
      const settings = [];
      if (kind === 'Deployment' || kind === 'StatefulSet') settings.push(field(['spec', 'replicas'], 'k8s.field.replicas', 'number'));
      if (kind === 'StatefulSet') settings.push(field(['spec', 'serviceName'], 'k8s.field.serviceName', 'string'));
      if (kind === 'CronJob') {
        settings.push(field(['spec', 'schedule'], 'k8s.field.schedule', 'string'));
        settings.push(select(['spec', 'concurrencyPolicy'], 'k8s.field.concurrencyPolicy', ['', 'Allow', 'Forbid', 'Replace']));
      }
      if (kind === 'Job' || kind === 'CronJob') {
        const jobBase = kind === 'Job' ? ['spec'] : ['spec', 'jobTemplate', 'spec'];
        settings.push(field([...jobBase, 'backoffLimit'], 'k8s.field.backoffLimit', 'number'));
        settings.push(select([...pod.path, 'restartPolicy'], 'k8s.field.restartPolicy', ['OnFailure', 'Never']));
      }
      settings.push(field([...pod.path, 'securityContext', 'runAsNonRoot'], 'k8s.field.runAsNonRoot', 'boolean'));
      group('spec', 'k8s.group.spec', settings);
      group('containers', 'k8s.group.containers', [], adder('container', [...pod.path, 'containers'], 'k8s.group.addContainer',
        [['name', 'name'], ['image', 'image']]));

      for (const { c, path, init } of containersOf(pod)) {
        const i = path.at(-1);
        const id = init ? `init-${i}` : String(i);
        const title = str(c.name) ?? `#${i}`;
        const fields = [
          // Removing the name field removes the whole container.
          field([...path, 'name'], 'k8s.field.name', 'string', '', { removable: true }),
          field([...path, 'image'], 'k8s.field.image', 'string'),
          select([...path, 'imagePullPolicy'], 'k8s.field.imagePullPolicy', ['', 'Always', 'IfNotPresent', 'Never']),
        ];
        for (const key of ['command', 'args']) {
          const list = arr(c[key]);
          if (list.some((v) => String(str(v)).includes('\n'))) {
            // Multi-line items cannot share one line-based box.
            list.forEach((_, j) => fields.push({ ...field([...path, key, j], null, 'text'), label: `${key}[${j}]` }));
          } else {
            fields.push({ path: [...path, key], labelKey: `k8s.field.${key}`, label: key, type: 'text', value: list.map((v) => str(v) ?? '').join('\n') });
          }
        }
        for (const [section, resource, labelKey] of [['requests', 'cpu', 'requestsCpu'], ['requests', 'memory', 'requestsMemory'], ['limits', 'cpu', 'limitsCpu'], ['limits', 'memory', 'limitsMemory']]) {
          fields.push(field([...path, 'resources', section, resource], `k8s.field.${labelKey}`, 'string'));
        }
        for (const [key, fallback] of [['runAsNonRoot', get(pod.spec, ['securityContext', 'runAsNonRoot'])], ['allowPrivilegeEscalation', true], ['readOnlyRootFilesystem', false], ['privileged', false]]) {
          fields.push(field([...path, 'securityContext', key], `k8s.field.${key}`, 'boolean', fallback));
        }
        group(`container-${id}`, init ? 'k8s.group.initContainer' : 'k8s.group.container', fields, undefined, title);

        const ports = arr(c.ports).flatMap((_, j) => [
          field([...path, 'ports', j, 'containerPort'], 'k8s.field.containerPort', 'number', '', { removable: true }),
          field([...path, 'ports', j, 'name'], 'k8s.field.portName', 'string'),
        ]);
        group(`ports-${id}`, 'k8s.group.ports', ports, adder('port', [...path, 'ports'], 'k8s.group.addPort',
          [['containerPort', 'containerPort', 'number'], ['name', 'portName']]), title);

        const env = arr(c.env).flatMap((raw, j) => {
          const entry = map(raw);
          const name = str(entry.name) ?? `#${j}`;
          const base = [...path, 'env', j];
          const source = entries(entry.valueFrom)[0];
          if (!source) return [{ ...field([...base, 'value'], null, 'string', '', { removable: true }), label: name }];
          const [type, ref] = source;
          return entries(ref).filter(([, v]) => typeof v === 'string').map(([key], n) => ({
            ...field([...base, 'valueFrom', type, key], null, 'string', '', { removable: n === 0 }),
            label: `${name} ← ${type}.${key}`,
          }));
        });
        group(`env-${id}`, 'k8s.group.env', env, adder('env', [...path, 'env'], 'k8s.group.addEnv',
          [['name', 'name'], ['value', 'value']]), title);
      }
    }

    function dataForm() {
      const secret = kind === 'Secret';
      if (secret) group('spec', 'k8s.group.spec', [field(['type'], 'k8s.field.type', 'string')]);
      const data = mapFields(['data'], (key) => {
        if (!secret) return {};
        const raw = str(map(js.data)[key]) ?? '';
        const decoded = decodeBase64(raw);
        // Invalid base64 is shown as is so it can be retyped; binary content stays hidden.
        const value = decoded.text ?? (decoded.valid ? '' : raw);
        const extra = { secret: true, value, type: value.includes('\n') ? 'text' : 'string' };
        if (decoded.valid && decoded.text === null) extra.label = `${key} (binary)`;
        return extra;
      });
      const addData = adder('data', ['data'], 'k8s.group.addData', [['key', 'key'], ['value', 'value', 'text']]);
      group('data', 'k8s.group.data', data, addData);
      if (secret && isMap(js.stringData)) group('stringData', 'k8s.group.stringData', mapFields(['stringData'], () => ({ secret: true })));
    }

    function ingressForm() {
      group('spec', 'k8s.group.spec', [field(['spec', 'ingressClassName'], 'k8s.field.ingressClassName', 'string')]);
      const backendInputs = [['path', 'path'], ['service', 'backendService'], ['port', 'backendPort']];
      group('rules', 'k8s.group.rules', [], adder('ingressRule', ['spec', 'rules'], 'k8s.group.addRule', [['host', 'host'], ...backendInputs]));
      arr(get(js, ['spec', 'rules'])).forEach((rule, i) => {
        const base = ['spec', 'rules', i];
        const fields = [field([...base, 'host'], 'k8s.field.host', 'string')];
        arr(map(map(rule).http).paths).forEach((entry, j) => {
          const path = [...base, 'http', 'paths', j];
          const port = map(get(entry, ['backend', 'service', 'port']));
          fields.push(
            field([...path, 'path'], 'k8s.field.path', 'string', '', { removable: true }),
            select([...path, 'pathType'], 'k8s.field.pathType', ['Prefix', 'Exact', 'ImplementationSpecific']),
            field([...path, 'backend', 'service', 'name'], 'k8s.field.backendService', 'string'),
            port.name !== undefined
              ? field([...path, 'backend', 'service', 'port', 'name'], 'k8s.field.backendPort', 'string')
              : field([...path, 'backend', 'service', 'port', 'number'], 'k8s.field.backendPort', 'number'),
          );
        });
        group(`rule-${i}`, 'k8s.group.rule', fields, adder('ingressPath', [...base, 'http', 'paths'], 'k8s.group.addPath', backendInputs), str(map(rule).host) ?? `#${i}`);
      });
    }
  }

  // ----- editing -----

  function open(text, docIndex) {
    const state = load(text);
    if (state.tooLarge) fail('k8s.err.tooLarge', { limit: MAX_LENGTH / 1024 });
    const doc = state.docs[docIndex];
    if (!doc) fail('k8s.err.noDocument');
    if (doc.errors.length || doc.aliasProblem) fail('k8s.err.broken', { line: lineAt(state, doc.offset + (doc.errors[0]?.offset ?? 0)) });
    return { state, doc, body: state.text.slice(doc.segment.bodyStart, doc.segment.bodyEnd) };
  }

  const finish = (state, text) => state.bom + (state.eol === '\n' ? text : text.replace(/\n/g, state.eol));

  function replaceBody({ state, doc }, body) {
    return finish(state, state.text.slice(0, doc.segment.bodyStart) + body + state.text.slice(doc.segment.bodyEnd));
  }

  /** Re-serialises one document, keeping its indentation style. */
  function serialize({ doc, body }) {
    const indent = /^[^\s#-][^\n]*:[ \t]*(?:#.*)?\n(?:[ \t]*(?:#.*)?\n)*( +)[^\s#-]/m.exec(body)?.[1].length
      ?? /^( +)[^\s#]/m.exec(body)?.[1].length ?? 2;
    const flush = /^( *)[^\s#-][^\n]*:[ \t]*(?:#.*)?\n(?:[ \t]*(?:#.*)?\n)*\1- /m.test(body);
    let output;
    try {
      output = doc.yaml.toString({
        lineWidth: 0,
        indent: Math.min(Math.max(indent, 1), 8),
        indentSeq: !flush,
        flowCollectionPadding: !/:[ \t]+[[{][^\s\]}]/.test(body),
      });
    } catch {
      fail('k8s.err.rewrite');
    }
    const parsed = parseBody(output);
    if (parsed.errors.length) fail('k8s.err.rewrite');
    output = alignComments(body, output, parsed);
    // Keep the original trailing blank lines (or the missing final newline).
    return output.trimEnd() + body.slice(body.trimEnd().length);
  }

  /** The serializer collapses the spaces before trailing comments; put them back. */
  function alignComments(before, after, parsed) {
    const collapse = (line) => line.replace(/[ \t]+#/, ' #');
    const originals = new Map(before.split('\n').filter((l) => /[ \t]{2}#|\t#/.test(l)).map((l) => [collapse(l), l]));
    if (!originals.size || parsed.js === undefined) return after;
    const restored = after.split('\n').map((l) => originals.get(l) ?? l).join('\n');
    // Never let this touch data, e.g. a "#" inside a block scalar.
    return sameData(parseBody(restored).yaml, parsed.js) ? restored : after;
  }

  const quoteIfAmbiguous = (scalar) => {
    if (typeof scalar.value === 'string' && !scalar.value.includes('\n') && AMBIGUOUS.test(scalar.value)
      && scalar.type !== 'QUOTE_SINGLE') scalar.type = 'QUOTE_DOUBLE';
  };

  function createNode(yamlDoc, value) {
    const node = yamlDoc.createNode(value, { aliasDuplicateObjects: false });
    if (YAML.isScalar(node)) quoteIfAmbiguous(node);
    else YAML.visit(node, { Scalar: (_, scalar) => quoteIfAmbiguous(scalar) });
    return node;
  }

  const newKey = (key) => {
    const scalar = new YAML.Scalar(String(key));
    quoteIfAmbiguous(scalar);
    return scalar;
  };

  const childOf = (node, key) => (YAML.isMap(node) ? findPair(node, key)?.value : YAML.isSeq(node) ? node.items[key] : undefined);

  const isEmpty = (node) => node === undefined || node === null || (YAML.isScalar(node) && (node.value === null));

  function attach(parent, key, node, path) {
    if (YAML.isSeq(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.items.length) fail('k8s.err.path', { path: dotted(path) });
      parent.items[key] = node;
      return;
    }
    const pair = findPair(parent, key);
    if (pair) pair.value = node;
    else parent.items.push(new YAML.Pair(newKey(key), node));
  }

  function keepComments(from, to) {
    if (!from || typeof from !== 'object') return;
    if (from.comment) to.comment = from.comment;
    if (from.commentBefore) to.commentBefore = from.commentBefore;
    if (from.spaceBefore) to.spaceBefore = true;
    if (from.anchor) to.anchor = from.anchor;
  }

  /** Walks to the parent of path[-1], creating missing maps and lists. */
  function ensureParent(yamlDoc, path) {
    if (isEmpty(yamlDoc.contents)) yamlDoc.contents = new YAML.YAMLMap(yamlDoc.schema);
    let node = yamlDoc.contents;
    for (let i = 0; i < path.length - 1; i++) {
      if (YAML.isAlias(node)) fail('k8s.err.alias', { path: dotted(path) });
      if (!YAML.isCollection(node)) fail('k8s.err.path', { path: dotted(path) });
      let child = childOf(node, path[i]);
      if (isEmpty(child)) {
        const created = typeof path[i + 1] === 'number' ? new YAML.YAMLSeq(yamlDoc.schema) : new YAML.YAMLMap(yamlDoc.schema);
        keepComments(child, created);
        attach(node, path[i], created, path);
        child = created;
      }
      if (YAML.isAlias(child)) fail('k8s.err.alias', { path: dotted(path) });
      if (!YAML.isCollection(child)) fail('k8s.err.path', { path: dotted(path) });
      if (child.items.length === 0) child.flow = false;
      node = child;
    }
    return node;
  }

  function coerce(js, path, value) {
    const last = path.at(-1);
    const inStringMap = path.slice(0, -1).some((k) => STRING_MAPS.has(k));
    const envValue = last === 'value' && path.at(-3) === 'env';
    const commandItem = typeof last === 'number' && ['command', 'args'].includes(path.at(-2));
    if (inStringMap || envValue || commandItem) {
      const text = String(value ?? '');
      return { value: knownKind(js) === 'Secret' && path[0] === 'data' && path.length === 2 ? encodeBase64(text) : text, remove: false };
    }
    if (last === 'command' || last === 'args') {
      const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split('\n').filter((l) => l !== '');
      return { value: list, remove: list.length === 0 };
    }
    const optional = OPTIONAL_KEYS.has(last) || (typeof last === 'number' && path.at(-2) === 'accessModes');
    if (value === '' || value === null || value === undefined) return { value: '', remove: optional, skipIfMissing: true };
    // "targetPort" and "port.targetPort" may name a port; "type" is never numeric.
    if (NUMBER_KEYS.has(last) && !(last === 'port' && path.at(-2) === 'spec')) {
      const text = String(value).trim();
      if (/^-?\d{1,15}$/.test(text)) return { value: Number(text), remove: false };
      if (last !== 'targetPort') fail('k8s.err.number', { value: clip(value) });
      return { value: text, remove: false };
    }
    // Plain numbers stay unquoted for quantities such as "cpu: 2".
    if (path.includes('resources') && /^\d{1,15}$/.test(String(value))) return { value: Number(value), remove: false };
    if (BOOLEAN_KEYS.has(last)) {
      if (value === true || value === 'true') return { value: true, remove: false };
      if (value === false || value === 'false') return { value: false, remove: false };
      fail('k8s.err.boolean', { value: clip(value) });
    }
    return { value: String(value), remove: false };
  }

  /** Replaces only the characters of an existing one-line scalar, when that gives the same result. */
  function splice(opened, node, value) {
    const { body } = opened;
    if (!node.range || node.range[1] <= node.range[0] || String(node.type).startsWith('BLOCK')) return null;
    if (typeof value === 'string' && value.includes('\n')) return null;
    if (body.slice(node.range[0], node.range[1]).includes('\n')) return null;
    const quoted = node.type === 'QUOTE_SINGLE' || node.type === 'QUOTE_DOUBLE';
    let token;
    if (typeof value !== 'string') token = String(value);
    else {
      const type = quoted ? node.type : AMBIGUOUS.test(value) ? 'QUOTE_DOUBLE' : 'PLAIN';
      token = YAML.stringify(value, { lineWidth: 0, defaultStringType: type }).replace(/\n$/, '');
    }
    if (token.includes('\n')) return null;
    const next = body.slice(0, node.range[0]) + token + body.slice(node.range[1]);
    const parsed = parseBody(next);
    if (parsed.errors.length || parsed.js === undefined) return null;
    return { next, parsed };
  }

  function setValue(text, docIndex, path, value) {
    const opened = open(text, docIndex);
    const { doc } = opened;
    if (!Array.isArray(path) || !path.length) fail('k8s.err.path', { path: '' });
    const result = coerce(doc.js, path, value);

    let existing = doc.yaml.contents;
    for (const key of path) {
      if (YAML.isAlias(existing)) fail('k8s.err.alias', { path: dotted(path) });
      existing = childOf(existing, key);
      if (existing === undefined) break;
    }
    if (result.remove) return existing === undefined ? text : removeAt(text, docIndex, path, true);
    if (existing === undefined && result.skipIfMissing) return text;
    if (YAML.isAlias(existing)) fail('k8s.err.alias', { path: dotted(path) });
    if (YAML.isCollection(existing) && !Array.isArray(result.value)) fail('k8s.err.path', { path: dotted(path) });

    if (YAML.isScalar(existing) && !Array.isArray(result.value)) {
      if (existing.value === result.value) return text;
      const spliced = splice(opened, existing, result.value);
      if (spliced) {
        // The splice must change exactly this value and nothing else.
        const check = parseBody(opened.body).yaml;
        let node = check.contents;
        for (const key of path) node = childOf(node, key);
        node.value = result.value;
        if (sameData(check, spliced.parsed.js)) return replaceBody(opened, spliced.next);
      }
    }

    const parent = ensureParent(doc.yaml, path);
    const key = path.at(-1);
    if (YAML.isScalar(existing) && !Array.isArray(result.value)) {
      existing.value = result.value;
      delete existing.format;
      delete existing.minFractionDigits;
      if (typeof result.value !== 'string') existing.type = 'PLAIN';
      else if (result.value.includes('\n')) existing.type = 'BLOCK_LITERAL';
      else {
        if (String(existing.type).startsWith('BLOCK')) existing.type = 'PLAIN';
        quoteIfAmbiguous(existing);
      }
    } else {
      const node = createNode(doc.yaml, result.value);
      keepComments(existing, node);
      if (YAML.isSeq(node) && (YAML.isSeq(existing) ? existing.flow : ['command', 'args'].includes(key))) node.flow = true;
      if (YAML.isMap(parent) || YAML.isSeq(parent)) attach(parent, key, node, path);
      else fail('k8s.err.path', { path: dotted(path) });
    }
    return replaceBody(opened, serialize(opened));
  }

  function sameData(yamlDoc, js) {
    try {
      return JSON.stringify(yamlDoc.toJS({ maxAliasCount: MAX_ALIASES })) === JSON.stringify(js);
    } catch {
      return false;
    }
  }

  /** Removing the identifying field of a list entry removes the entry. */
  function entryPath(path) {
    for (let i = path.length - 2; i >= 0; i--) {
      if (typeof path[i + 1] !== 'number') continue;
      const list = path[i];
      const rest = path.slice(i + 2);
      if (!rest.length) return path;
      if (list === 'env' && (rest[0] === 'value' || rest[0] === 'valueFrom')) return path.slice(0, i + 2);
      if (list === 'ports' && rest.length === 1 && (rest[0] === 'containerPort' || rest[0] === 'port')) return path.slice(0, i + 2);
      if (list === 'paths' && rest.length === 1 && rest[0] === 'path') return path.slice(0, i + 2);
      if ((list === 'containers' || list === 'initContainers') && rest.length === 1 && rest[0] === 'name') return path.slice(0, i + 2);
    }
    return path;
  }

  function removeAt(text, docIndex, path, exact = false) {
    const opened = open(text, docIndex);
    const { doc } = opened;
    if (!Array.isArray(path) || !path.length) fail('k8s.err.path', { path: '' });
    const target = exact === true ? path : entryPath(path);
    const chain = [doc.yaml.contents];
    for (const key of target) {
      const node = chain.at(-1);
      if (YAML.isAlias(node)) fail('k8s.err.alias', { path: dotted(path) });
      const child = childOf(node, key);
      if (child === undefined) return text;
      chain.push(child);
    }
    for (let depth = target.length - 1; depth >= 0; depth--) {
      const parent = chain[depth];
      const key = target[depth];
      if (YAML.isSeq(parent)) parent.items.splice(key, 1);
      else parent.items.splice(parent.items.indexOf(findPair(parent, key)), 1);
      // Drop containers that became empty and mean nothing when empty.
      if (parent.items.length || depth === 0) break;
      const name = target[depth - 1];
      const emptyPathEntry = typeof name === 'number' && target[depth - 2] === 'paths';
      const http = name === 'http';
      if (!(PRUNABLE.has(name) || http || emptyPathEntry)) break;
    }
    return replaceBody(opened, serialize(opened));
  }

  function addItem(text, docIndex, add, values = {}) {
    const opened = open(text, docIndex);
    const { doc } = opened;
    const value = (name) => String(values[name] ?? '').trim();
    const required = (name) => value(name) || fail('k8s.err.required', { name });
    const port = (name) => {
      const raw = required(name);
      if (!/^\d+$/.test(raw) || !isPort(Number(raw))) fail('k8s.err.port', { value: clip(raw) });
      return Number(raw);
    };
    const portOrName = (name) => (/^\d+$/.test(required(name)) ? port(name) : value(name));
    const path = [...add.path];

    const current = (at) => {
      let node = doc.yaml.contents;
      for (const key of at) {
        if (YAML.isAlias(node)) fail('k8s.err.alias', { path: dotted(at) });
        node = childOf(node, key);
        if (node === undefined) break;
      }
      return node;
    };
    const list = (at) => arr(get(doc.js, at)).map(map);
    const append = (at, item) => {
      const parent = ensureParent(doc.yaml, [...at, 0]);
      if (!YAML.isSeq(parent)) fail('k8s.err.path', { path: dotted(at) });
      parent.items.push(createNode(doc.yaml, item));
    };
    const unique = (at, key, wanted) => {
      if (list(at).some((item) => str(item[key]) === String(wanted))) fail('k8s.err.duplicate', { name: clip(wanted) });
    };
    const backend = () => {
      const wanted = portOrName('port');
      return {
        path: value('path') || '/', pathType: 'Prefix',
        backend: { service: { name: required('service'), port: typeof wanted === 'number' ? { number: wanted } : { name: wanted } } },
      };
    };

    switch (add.type) {
      case 'env': {
        const name = required('name');
        unique(path, 'name', name);
        append(path, { name, value: String(values.value ?? '') });
        break;
      }
      case 'port': {
        const containerPort = port('containerPort');
        unique(path, 'containerPort', containerPort);
        if (value('name')) unique(path, 'name', value('name'));
        append(path, value('name') ? { name: value('name'), containerPort } : { containerPort });
        break;
      }
      case 'servicePort': {
        const number = port('port');
        unique(path, 'port', number);
        const existing = list(path);
        const item = { port: number };
        if (value('targetPort')) item.targetPort = portOrName('targetPort');
        let name = value('name');
        if (!name && existing.length) name = `port-${number}`;
        if (name) {
          unique(path, 'name', name);
          // Several ports require every one of them to be named.
          existing.forEach((p, i) => {
            if (!p.name && isPort(p.port)) {
              const entry = childOf(current(path), i);
              if (YAML.isMap(entry)) entry.items.unshift(new YAML.Pair(newKey('name'), createNode(doc.yaml, `port-${p.port}`)));
            }
          });
        }
        append(path, name ? { name, ...item } : item);
        break;
      }
      case 'data':
      case 'selector': {
        const key = required('key');
        const at = [...path, key];
        if (current(at) !== undefined) fail('k8s.err.duplicate', { name: clip(key) });
        const parent = ensureParent(doc.yaml, at);
        if (!YAML.isMap(parent)) fail('k8s.err.path', { path: dotted(path) });
        const raw = String(values.value ?? '');
        attach(parent, key, createNode(doc.yaml, coerce(doc.js, at, raw).value), at);
        break;
      }
      case 'container': {
        const name = required('name');
        if (name.length > 63 || !DNS_LABEL.test(name)) fail('k8s.err.name', { kind: 'container', name: clip(name) });
        const parentPath = path.slice(0, -1);
        unique(path, 'name', name);
        unique([...parentPath, 'initContainers'], 'name', name);
        append(path, {
          name, image: required('image'),
          resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
          securityContext: { allowPrivilegeEscalation: false },
        });
        break;
      }
      case 'ingressRule': {
        const rule = { http: { paths: [backend()] } };
        append(path, value('host') ? { host: value('host'), ...rule } : rule);
        break;
      }
      case 'ingressPath':
        append(path, backend());
        break;
      default:
        fail('k8s.err.path', { path: dotted(path) });
    }
    return replaceBody(opened, serialize(opened));
  }

  function addDocument(text, kind, { name } = {}) {
    const state = load(text);
    if (state.tooLarge) fail('k8s.err.tooLarge', { limit: MAX_LENGTH / 1024 });
    let chosen = name;
    if (!chosen) {
      const used = new Set(state.docs.map(identity).filter((d) => d.kind === kind).map((d) => d.name));
      chosen = 'app';
      for (let i = 2; used.has(chosen); i++) chosen = `app-${i}`;
    }
    const added = template(kind, { name: chosen });
    const base = state.text.trimEnd();
    if (!base) return finish(state, added);
    const separator = !state.docs.length || /(^|\n)---[ \t]*$/.test(base) ? '\n' : '\n---\n';
    return finish(state, base + separator + added);
  }

  function removeDocument(text, docIndex) {
    const state = load(text);
    if (state.tooLarge) fail('k8s.err.tooLarge', { limit: MAX_LENGTH / 1024 });
    const doc = state.docs[docIndex];
    if (!doc) fail('k8s.err.noDocument');
    const { start, end } = doc.segment;
    let before = state.text.slice(0, start);
    let after = state.text.slice(end);
    if (!before.trim()) after = after.replace(/^---[ \t]*\n/, '');
    else if (after && !/^---([ \t]|\n|$)/.test(after) && !/(^|\n)\.\.\.[ \t]*\n$/.test(before)) after = `---\n${after}`;
    if (!after && before && !before.endsWith('\n')) before += '\n';
    return finish(state, before + after);
  }

  // ----- summary -----

  function summary(text) {
    const state = load(text);
    const idx = index(state);
    const objects = [];
    const links = [];
    const linked = new Set();
    const link = (from, to, type, label) => {
      const key = JSON.stringify([from, to, type, label]);
      if (!linked.has(key) && links.length < 1000) links.push({ from, to, type, label });
      linked.add(key);
    };

    for (const doc of state.docs) {
      const id = identity(doc);
      const lines = [];
      objects.push({ doc: doc.index, kind: id.kind, name: id.name, lines });
      const kind = knownKind(doc.js);
      if (!kind) continue;
      const js = doc.js;
      const spec = map(js.spec);
      const push = (line) => {
        if (lines.length < 50) lines.push(line);
      };
      if (id.namespace) push(`namespace: ${clip(id.namespace)}`);
      const pod = podInfo(js);

      if (pod) {
        if (kind === 'Deployment' || kind === 'StatefulSet') push(`replicas: ${clip(spec.replicas ?? 1)}`);
        if (kind === 'CronJob') push(`schedule: ${clip(spec.schedule)}`);
        for (const { c, init } of containersOf(pod)) {
          const ports = arr(c.ports).map((p) => clip(map(p).containerPort)).join(', ');
          push(`${init ? 'init ' : ''}${clip(c.name ?? '?')}: ${clip(c.image ?? '?')}${ports ? ` [${ports}]` : ''}`);
        }
        for (const ref of references(pod)) {
          link(doc.index, idx.find(ref.kind, ref.name, id.namespace)?.doc ?? null, 'uses', `${ref.kind}/${clip(ref.name)}`);
        }
        if (kind === 'StatefulSet' && str(spec.serviceName)) {
          link(doc.index, idx.find('Service', str(spec.serviceName), id.namespace)?.doc ?? null, 'uses', `Service/${clip(spec.serviceName)}`);
        }
      } else if (kind === 'Service') {
        push(`type: ${clip(spec.type ?? 'ClusterIP')}`);
        for (const p of arr(spec.ports).map(map)) push(`port ${clip(p.port)} → ${clip(p.targetPort ?? p.port)}`);
        if (entries(spec.selector).length) {
          const label = clip(selectorText(spec.selector));
          push(`selector: ${label}`);
          const matched = idx.select(spec.selector, id.namespace);
          if (!matched.length) link(doc.index, null, 'selects', label);
          for (const w of matched) link(doc.index, w.doc, 'selects', label);
        }
      } else if (kind === 'ConfigMap' || kind === 'Secret') {
        if (kind === 'Secret') push(`type: ${clip(js.type ?? 'Opaque')}`);
        // Key names only: values may be sensitive.
        const keys = ['data', 'stringData', 'binaryData'].flatMap((f) => Object.keys(map(js[f])));
        push(`keys: ${clip(keys.join(', '), 200)}`);
      } else if (kind === 'Ingress') {
        const route = (backend, from) => {
          const service = map(map(backend).service);
          const name = str(service.name);
          if (!name) return;
          const label = `${from} → ${clip(name)}:${clip(map(service.port).number ?? map(service.port).name ?? '?')}`;
          push(label);
          link(doc.index, idx.find('Service', name, id.namespace)?.doc ?? null, 'routes', label);
        };
        if (spec.defaultBackend) route(spec.defaultBackend, '*');
        for (const rule of arr(spec.rules).map(map)) {
          for (const entry of arr(map(rule.http).paths).map(map)) route(entry.backend, clip(`${str(rule.host) ?? '*'}${str(entry.path) ?? ''}`));
        }
        for (const tls of arr(spec.tls).map(map)) {
          const name = str(tls.secretName);
          if (name) link(doc.index, idx.find('Secret', name, id.namespace)?.doc ?? null, 'uses', `Secret/${clip(name)}`);
        }
      } else if (kind === 'Route') {
        const name = str(map(spec.to).name);
        if (name) {
          const port = str(map(spec.port).targetPort);
          const label = `${clip(spec.host ?? '*')} → ${clip(name)}${port ? `:${clip(port)}` : ''}`;
          push(label);
          link(doc.index, idx.find('Service', name, id.namespace)?.doc ?? null, 'routes', label);
        }
        if (spec.tls) push(`tls: ${clip(map(spec.tls).termination)}`);
      } else {
        push(`storage: ${clip(get(spec, ['resources', 'requests', 'storage']))}`);
        push(`accessModes: ${clip(arr(spec.accessModes).map((m) => str(m)).join(', '))}`);
      }
    }
    return { objects, links };
  }

  function images(text) {
    const state = load(text);
    const out = [];
    for (const doc of state.docs) {
      const pod = podInfo(doc.js);
      if (!pod) continue;
      for (const { c, path } of containersOf(pod)) {
        const ref = str(c.image);
        if (ref && out.length < 500) out.push({ ref, doc: doc.index, line: lineOf(state, doc, [...path, 'image']), container: str(c.name) });
      }
    }
    return out;
  }

  return {
    template,
    parse,
    validate,
    form,
    setValue,
    removeAt: (text, docIndex, path) => removeAt(text, docIndex, path),
    addItem,
    addDocument,
    removeDocument,
    summary,
    images,
  };
}
