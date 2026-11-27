import test from 'node:test';
import assert from 'node:assert/strict';
import * as YAML from 'yaml';
import { createK8s, KINDS } from '../public/core/k8s.js';
import { K8S_MESSAGES } from '../public/core/k8s-i18n.js';
import { LocalizedError } from '../public/core/i18n.js';

const k8s = createK8s(YAML);
const codes = (text, severity, options) => k8s.validate(text, options).filter((d) => !severity || d.severity === severity).map((d) => d.code);
const js = (text, index = 0) => YAML.parseAllDocuments(text)[index].toJS();
const throwsKey = (fn, key) => assert.throws(fn, (e) => e instanceof LocalizedError && e.key === key && e.message !== key);
const C = ['spec', 'template', 'spec', 'containers', 0];
const image = (extra = {}) => ({ expose: ['8080/tcp'], user: '101', entrypoint: null, cmd: null, known: true, ...extra });

test('every template validates without errors or warnings', () => {
  for (const kind of KINDS) {
    for (const name of [undefined, 'my-thing', '123', 'on']) {
      if (kind === 'Service' && name === '123') continue;
      const text = k8s.template(kind, { name });
      assert.deepEqual(k8s.validate(text).filter((d) => d.severity !== 'info'), [], `${kind} ${name}\n${text}`);
      assert.equal(k8s.parse(text).docs[0].kind, kind);
      assert.equal(k8s.parse(text).docs[0].name, name ?? 'app');
      assert.ok(k8s.form(text, 0).groups.length > 0);
    }
  }
});

test('all templates together link up without errors or warnings', () => {
  let text = '';
  for (const kind of KINDS) text = k8s.addDocument(text, kind);
  assert.equal(k8s.parse(text).docs.length, KINDS.length);
  assert.deepEqual(k8s.validate(text, { image: image() }).filter((d) => d.severity !== 'info'), []);
  const { objects, links } = k8s.summary(text);
  assert.equal(objects.length, KINDS.length);
  assert.ok(links.some((l) => l.type === 'selects' && l.to === 0));
  assert.equal(links.filter((l) => l.type === 'routes' && l.to === 4).length, 2);
});

test('rejects bad template names and kinds', () => {
  throwsKey(() => k8s.template('Pod'), 'k8s.err.kind');
  throwsKey(() => k8s.template('Service', { name: '1abc' }), 'k8s.err.name');
  throwsKey(() => k8s.template('Deployment', { name: 'a\nkind: x' }), 'k8s.err.name');
});

const COMMENTED = `# file header
apiVersion: v1
kind: ConfigMap   # a comment on kind
metadata:
  name: settings
data:
  # keep me
  MODE: "fast"   # trailing
---
# second document
apiVersion: apps/v1
kind: Deployment
metadata: {name: web}
spec:
  replicas: 1 # how many
  selector:
    matchLabels: {app: web}
  template:
    metadata:
      labels: {app: web}
    spec:
      containers:
      - name: web   # main
        image: nginx:1.27
        env:
        - name: A
          value: "1"
`;

test('editing a scalar changes only that value', () => {
  assert.equal(k8s.setValue(COMMENTED, 1, ['spec', 'replicas'], '3'), COMMENTED.replace('replicas: 1 #', 'replicas: 3 #'));
  assert.equal(k8s.setValue(COMMENTED, 0, ['data', 'MODE'], 'slow'), COMMENTED.replace('"fast"', '"slow"'));
  assert.equal(k8s.setValue(COMMENTED, 1, [...C, 'image'], 'nginx:1.28'), COMMENTED.replace('nginx:1.27', 'nginx:1.28'));
});

test('adding and removing keeps comments, indentation and other documents', () => {
  const first = COMMENTED.slice(0, COMMENTED.indexOf('---'));
  const added = k8s.setValue(COMMENTED, 1, [...C, 'resources', 'limits', 'memory'], '64Mi');
  assert.ok(added.startsWith(first));
  for (const comment of ['# second document', '# how many', '# main']) assert.ok(added.includes(comment), comment);
  assert.ok(added.includes('\n      - name: web'), 'flush list indentation is kept');
  assert.ok(added.includes('metadata: {name: web}'), 'flow style is kept');
  assert.equal(js(added, 1).spec.template.spec.containers[0].resources.limits.memory, '64Mi');

  const removed = k8s.removeAt(added, 1, [...C, 'resources', 'limits', 'memory']);
  assert.equal(removed, COMMENTED);
  const noEnv = k8s.removeAt(COMMENTED, 1, [...C, 'env', 0, 'value']);
  assert.equal(js(noEnv, 1).spec.template.spec.containers[0].env, undefined);
  assert.ok(noEnv.includes('# main'));
});

test('values that kubectl would not read as strings are quoted', () => {
  let text = k8s.template('ConfigMap');
  for (const value of ['yes', 'on', '123', '1:30', 'null', '', 'a: b', '# x', 'line1\nline2\n']) {
    text = k8s.setValue(text, 0, ['data', 'LOG_LEVEL'], value);
    assert.equal(YAML.parse(text, { version: '1.1' }).data.LOG_LEVEL, value, JSON.stringify(value));
  }
  text = k8s.setValue(text, 0, ['data', 'on'], 'off');
  assert.deepEqual(codes(text, 'error'), []);
  const flow = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\ndata: {k: v, z: w}\n';
  assert.equal(js(k8s.setValue(flow, 0, ['data', 'k'], 'x, y}')).data.k, 'x, y}');
});

test('keeps CRLF line endings and a byte order mark', () => {
  const text = `\uFEFF${COMMENTED.replace(/\n/g, '\r\n')}`;
  const out = k8s.setValue(text, 1, ['spec', 'replicas'], 2);
  assert.equal(out, text.replace('replicas: 1', 'replicas: 2'));
  const added = k8s.setValue(text, 1, ['metadata', 'namespace'], 'prod');
  assert.ok(added.startsWith('\uFEFF') && !/[^\r]\n/.test(added));
});

test('empty values remove optional fields and do not create them', () => {
  const text = k8s.template('Deployment');
  assert.equal(k8s.setValue(text, 0, ['metadata', 'namespace'], ''), text);
  assert.equal(js(k8s.setValue(text, 0, ['spec', 'replicas'], '')).spec.replicas, undefined);
  throwsKey(() => k8s.setValue(text, 0, ['spec', 'replicas'], 'two'), 'k8s.err.number');
  const command = k8s.setValue(text, 0, [...C, 'args'], 'a\nb c\ntrue');
  assert.deepEqual(js(command).spec.template.spec.containers[0].args, ['a', 'b c', 'true']);
});

test('adds items from the form descriptors', () => {
  let text = k8s.template('Deployment');
  const addOf = (type, doc = 0) => k8s.form(text, doc).groups.map((g) => g.add).find((a) => a?.type === type);
  text = k8s.addItem(text, 0, addOf('env'), { name: 'MODE', value: 'true' });
  text = k8s.addItem(text, 0, addOf('port'), { containerPort: '9090', name: 'metrics' });
  text = k8s.addItem(text, 0, addOf('container'), { name: 'sidecar', image: 'busybox:1.36' });
  const containers = js(text).spec.template.spec.containers;
  assert.deepEqual(containers[0].env, [{ name: 'MODE', value: 'true' }]);
  assert.equal(containers[0].ports[1].containerPort, 9090);
  assert.equal(containers[1].name, 'sidecar');
  assert.deepEqual(codes(text, 'error'), []);
  throwsKey(() => k8s.addItem(text, 0, addOf('env'), { name: 'MODE' }), 'k8s.err.duplicate');
  throwsKey(() => k8s.addItem(text, 0, addOf('port'), { containerPort: '70000' }), 'k8s.err.port');
  throwsKey(() => k8s.addItem(text, 0, addOf('container'), { name: 'x' }), 'k8s.err.required');

  text = k8s.template('Service');
  text = k8s.addItem(text, 0, addOf('servicePort'), { port: '9090', targetPort: 'metrics' });
  text = k8s.addItem(text, 0, addOf('selector'), { key: 'tier', value: '1' });
  assert.equal(js(text).spec.ports[1].name, 'port-9090');
  assert.equal(js(text).spec.selector.tier, '1');
  assert.deepEqual(codes(text, 'error'), []);

  text = k8s.template('Ingress');
  text = k8s.addItem(text, 0, addOf('ingressPath'), { path: '/api', service: 'api', port: 'http' });
  text = k8s.addItem(text, 0, addOf('ingressRule'), { host: 'b.example.com', service: 'app', port: '80' });
  assert.equal(js(text).spec.rules[0].http.paths[1].backend.service.port.name, 'http');
  assert.equal(js(text).spec.rules[1].host, 'b.example.com');
  assert.deepEqual(codes(text, 'error'), []);
  text = k8s.removeAt(text, 0, ['spec', 'rules', 1, 'http', 'paths', 0, 'path']);
  assert.deepEqual(js(text).spec.rules[1], { host: 'b.example.com' });
});

test('every removable form field and every form path can be used', () => {
  let text = '';
  for (const kind of KINDS) text = k8s.addDocument(text, kind);
  for (const doc of k8s.parse(text).docs) {
    for (const group of k8s.form(text, doc.index).groups) {
      assert.ok(Object.hasOwn(K8S_MESSAGES, group.labelKey), group.labelKey);
      for (const input of group.add?.inputs ?? []) assert.ok(Object.hasOwn(K8S_MESSAGES, input.labelKey), input.labelKey);
      if (group.add) assert.ok(Object.hasOwn(K8S_MESSAGES, group.add.labelKey), group.add.labelKey);
      for (const field of group.fields) {
        if (field.labelKey) assert.ok(Object.hasOwn(K8S_MESSAGES, field.labelKey), field.labelKey);
        // Writing back the shown value must not break the document.
        const same = k8s.setValue(text, doc.index, field.path, field.value);
        assert.deepEqual(codes(same, 'error'), [], `${doc.kind} ${field.path}`);
        if (field.removable) assert.equal(k8s.parse(k8s.removeAt(text, doc.index, field.path)).errors.length, 0);
      }
    }
  }
});

test('handles multiple documents', () => {
  const text = '# top\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\n---\n# only a comment\n---\nkind: Secret\napiVersion: v1\nmetadata:\n  name: b\n...\n';
  const parsed = k8s.parse(text);
  assert.deepEqual(parsed.docs.map((d) => [d.index, d.kind, d.name, d.line]), [[0, 'ConfigMap', 'a', 3], [1, 'Secret', 'b', 11]]);
  assert.deepEqual(parsed.errors, []);

  const added = k8s.addDocument(text, 'Service');
  assert.equal(k8s.parse(added).docs.length, 3);
  assert.ok(added.startsWith(text.trimEnd()));
  assert.equal(k8s.parse(k8s.addDocument(added, 'Service')).docs[3].name, 'app-2');

  const removed = k8s.removeDocument(added, 1);
  assert.deepEqual(k8s.parse(removed).docs.map((d) => d.kind), ['ConfigMap', 'Service']);
  assert.deepEqual(k8s.parse(removed).errors, []);
  assert.deepEqual(k8s.parse(k8s.removeDocument(added, 0)).docs.map((d) => d.kind), ['Secret', 'Service']);
  assert.equal(k8s.parse(k8s.removeDocument(k8s.template('Job'), 0)).docs.length, 0);
  const ended = 'kind: A\n---\nkind: B\n...\nkind: C\n';
  assert.deepEqual(k8s.parse(k8s.removeDocument(ended, 1)).docs.map((d) => d.kind), ['A', 'C']);
  assert.equal(k8s.addDocument('', 'Job'), k8s.template('Job'));
  assert.equal(k8s.parse(k8s.addDocument('---\n', 'Job')).docs.length, 1);
  throwsKey(() => k8s.removeDocument(text, 5), 'k8s.err.noDocument');
});

test('Secret data is edited as plain text and stored as base64', () => {
  let text = k8s.template('Secret');
  const field = () => k8s.form(text, 0).groups.find((g) => g.id === 'data').fields.find((f) => f.path[1] === 'password');
  assert.equal(field().value, 'change-me');
  assert.equal(field().secret, true);
  text = k8s.setValue(text, 0, ['data', 'password'], '비밀 päss');
  assert.equal(Buffer.from(js(text).data.password, 'base64').toString('utf8'), '비밀 päss');
  assert.equal(field().value, '비밀 päss');
  text = k8s.addItem(text, 0, k8s.form(text, 0).groups.find((g) => g.id === 'data').add, { key: 'token', value: 'abc' });
  assert.equal(js(text).data.token, 'YWJj');
  text = k8s.setValue(text, 0, ['stringData', 'plain'], 'as-is');
  assert.equal(js(text).stringData.plain, 'as-is');
  assert.deepEqual(codes(text, 'error'), []);
  assert.ok(!JSON.stringify(k8s.summary(text)).includes('YWJj'));
});

test('reports invalid base64 and data types', () => {
  const text = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  a: not base64!\n  b: 12\n  c: /w==\n';
  assert.deepEqual(codes(text, 'error'), ['base64', 'data-type']);
  const binary = k8s.form(text, 0).groups.find((g) => g.id === 'data').fields.find((f) => f.path[1] === 'c');
  assert.deepEqual([binary.value, binary.label], ['', 'c (binary)']);
});

const deployment = (container, pod = '') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
${pod}      containers:
        - ${container.split('\n').join('\n          ')}
`;
const SAFE = 'name: web\nimage: nginx:1.27\nresources: {requests: {cpu: 1}, limits: {memory: 1Gi}}\nsecurityContext: {runAsNonRoot: true}';

test('checks the common container mistakes', () => {
  assert.deepEqual(codes(deployment(SAFE)), []);
  assert.deepEqual(codes(deployment('name: web\nimage: nginx'), 'warning').sort(), ['image-latest', 'no-limits', 'no-requests', 'run-as-non-root']);
  const bad = deployment(`${SAFE}
ports:
  - {name: http, containerPort: 0}
  - {name: http, containerPort: 80}
env:
  - {name: A, value: 1}
  - {name: B}
  - {name: DB_PASSWORD, value: hunter22}
volumeMounts: [{name: nope, mountPath: /x}]`);
  assert.deepEqual(codes(bad).sort(), ['duplicate-name', 'env-type', 'env-value', 'plain-secret', 'port-range', 'volume-mount']);
  assert.deepEqual(codes(deployment('image: Bad Image')).filter((c) => c.includes('name') || c.includes('image')), ['container-name', 'image-invalid']);
  assert.ok(codes(deployment(SAFE.replace('runAsNonRoot: true', 'privileged: true'))).includes('privileged'));
  assert.ok(codes(deployment(SAFE.replace('cpu: 1', 'memory: 2Gi'))).includes('request-over-limit'));
  assert.ok(codes(deployment(SAFE.replace('1Gi', '1GB'))).includes('quantity'));
});

test('checks identity, selectors, job rules and cron schedules', () => {
  assert.deepEqual(codes('apiVersion: v1\nkind: Deployment\nmetadata: {name: Bad_Name}\nspec: {}\n', 'error').sort(),
    ['api-version', 'containers', 'name', 'selector-missing']);
  assert.ok(codes(deployment(SAFE).replace('        app: web', '        app: other')).includes('selector-mismatch'));
  assert.deepEqual(codes(k8s.template('Job').replace('Never', 'Always')), ['restart-policy']);
  const cron = k8s.template('CronJob');
  for (const good of ['*/5 * * * *', '0 0 1 JAN-MAR mon', '@daily', '1,2-5/2 3 ? * *']) {
    assert.deepEqual(codes(cron.replace('0 3 * * *', good)), [], good);
  }
  for (const bad of ['* * * *', '60 * * * *', '0 0 0 * *', 'every day', '*/0 * * * *', 'TZ=UTC 0 0 * * *', '0 0 * * 7']) {
    assert.deepEqual(codes(cron.replace('"0 3 * * *"', `"${bad}"`)), ['schedule'], bad);
  }
  assert.deepEqual(codes(`${k8s.template('Job')}---\n${k8s.template('Job')}`), ['duplicate-object']);
  assert.deepEqual(codes('apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: a}\nspec: {accessModes: [Once]}\n'), ['access-modes', 'storage']);
});

test('checks references between objects', () => {
  const refs = deployment(`${SAFE}
envFrom: [{configMapRef: {name: cfg}}]
env: [{name: T, valueFrom: {secretKeyRef: {name: sec, key: nope}}}]`);
  assert.deepEqual(codes(refs), ['ref-external', 'ref-external']);
  const secret = k8s.template('Secret', { name: 'sec' });
  const withSecret = `${refs}---\n${secret}`;
  assert.deepEqual(codes(withSecret).sort(), ['missing-key', 'ref-external']);
  const links = k8s.summary(withSecret).links.filter((l) => l.type === 'uses');
  assert.deepEqual(links.map((l) => [l.label, l.to]), [['Secret/sec', 1], ['ConfigMap/cfg', null]]);

  const service = k8s.template('Service', { name: 'web' });
  assert.deepEqual(codes(service), ['selector-external']);
  assert.ok(codes(`${deployment(SAFE)}---\n${service.replace(/name: web\n {2}ports/, 'name: zzz\n  ports')}`, 'warning').includes('selector-no-match'));
  assert.equal(k8s.summary(service).links[0].to, null);

  const wrongPort = `${service}---\n${k8s.template('Ingress', { name: 'web' }).replace('number: 80', 'number: 81')}`;
  assert.deepEqual(codes(wrongPort, 'error'), ['backend-port']);
  const route = `${service}---\n${k8s.template('Route', { name: 'web' }).replace('8080', 'nope')}`;
  assert.deepEqual(codes(route, 'warning'), ['backend-port']);
  const named = `${deployment(SAFE)}---\n${service.replace('targetPort: 8080', 'targetPort: web-port').replace('app.kubernetes.io/name', 'app')}`;
  assert.ok(codes(named, 'warning').includes('target-port'));
});

test('checks workloads against the linked Dockerfile', () => {
  const text = k8s.template('Deployment');
  const check = (extra, source = text) => k8s.validate(source, { image: image(extra) }).map((d) => `${d.severity}:${d.code}`);
  assert.deepEqual(check({}), []);
  assert.deepEqual(check({ expose: ['3000/tcp'] }).sort(), ['info:expose-unused', 'warning:port-not-exposed']);
  assert.deepEqual(check({ expose: [] }), ['info:port-not-exposed']);
  assert.deepEqual(check({ expose: ['8000-8100/tcp'] }), []);
  for (const user of [null, 'root', '0', '0:0']) assert.deepEqual(check({ user }), ['error:image-user'], String(user));
  assert.deepEqual(check({ user: null, known: false }), ['warning:image-user']);
  assert.deepEqual(check({ user: 'node' }), ['warning:image-user-name']);
  assert.deepEqual(check({ user: 'node' }, text.replace('runAsNonRoot: true', 'runAsNonRoot: true\n        runAsUser: 1000')), []);
  const override = k8s.setValue(k8s.setValue(text, 0, [...C, 'command'], 'sh'), 0, [...C, 'args'], '-c');
  assert.deepEqual(check({}, override), ['info:command-override', 'info:args-override']);
  assert.deepEqual(k8s.validate(text, { image: null }), []);
});

test('lists images with their lines', () => {
  const text = `${k8s.template('Service')}---\n${k8s.template('CronJob')}`;
  const [only, ...rest] = k8s.images(text);
  assert.equal(rest.length, 0);
  assert.deepEqual([only.ref, only.doc, only.container], ['busybox:1.36', 1, 'app']);
  assert.match(text.split('\n')[only.line - 1], /image: busybox/);
});

test('unsupported kinds are only noted and stay editable', () => {
  for (const text of ['apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n', 'apiVersion: serving.knative.dev/v1\nkind: Service\nmetadata:\n  name: k\n']) {
    assert.deepEqual(k8s.validate(text).map((d) => [d.severity, d.code]), [['info', 'unsupported-kind']]);
    assert.ok(k8s.setValue(text, 0, ['metadata', 'name'], 'q').includes('name: q'));
  }
});

test('refuses to rewrite broken YAML but still edits the healthy documents', () => {
  const broken = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: "open\n';
  const text = `${broken}---\n${k8s.template('Secret')}`;
  assert.deepEqual(k8s.parse(text).docs.map((d) => d.kind), ['ConfigMap', 'Secret']);
  assert.equal(k8s.parse(text).errors.length > 0, true);
  assert.equal(k8s.validate(text)[0].code, 'syntax');
  const add = { type: 'data', path: ['data'] };
  for (const bad of [broken, 'a: 1\na: 2\n', 'a: *missing\n', 'a:\n\tb: 1\n']) {
    throwsKey(() => k8s.setValue(bad, 0, ['metadata', 'name'], 'x'), 'k8s.err.broken');
    throwsKey(() => k8s.removeAt(bad, 0, ['metadata']), 'k8s.err.broken');
    throwsKey(() => k8s.addItem(bad, 0, add, { key: 'a' }), 'k8s.err.broken');
    assert.doesNotThrow(() => [k8s.form(bad, 0), k8s.summary(bad), k8s.images(bad)]);
  }
  assert.deepEqual(codes('a: 1\na: 2\n'), ['duplicate-key']);
  assert.ok(k8s.setValue(text, 1, ['metadata', 'name'], 'ok').startsWith(broken));
});

test('does not edit through aliases or into scalars', () => {
  const text = 'apiVersion: v1\nkind: ConfigMap\nmetadata: &m\n  name: a\ncopy: *m\ndata: text\n';
  throwsKey(() => k8s.setValue(text, 0, ['copy', 'name'], 'b'), 'k8s.err.alias');
  throwsKey(() => k8s.setValue(text, 0, ['data', 'k'], 'v'), 'k8s.err.path');
});

test('never throws on odd but valid structures', () => {
  const odd = [
    '- a\n- b\n', 'just text\n', 'null\n', 'kind: [1]\n', '{toString: 1, __proto__: {x: 1}}\n',
    'kind: Deployment\nspec: 3\n', 'apiVersion: apps/v1\nkind: Deployment\nmetadata: x\nspec: {template: {spec: {containers: [null, 1, {ports: 3, env: [null]}]}}}\n',
    'apiVersion: v1\nkind: Service\nmetadata: {name: {toString: 1}}\nspec: {ports: [null], selector: {a: {valueOf: 1}}}\n',
    'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: {name: a}\nspec: {rules: [null, {http: 1}], tls: [null]}\n',
    'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\ndata: {__proto__: x, constructor: y}\n',
  ];
  for (const text of odd) {
    assert.doesNotThrow(() => {
      k8s.parse(text);
      k8s.validate(text, { image: image() });
      k8s.form(text, 0);
      k8s.summary(text);
      k8s.images(text);
    }, text);
  }
});

test('alias bombs and huge input cannot hang validation', () => {
  const bomb = ['a0: &a0 [x,x,x,x,x,x,x,x,x]'];
  for (let i = 1; i < 10; i++) bomb.push(`a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(',')}]`);
  const merges = ['m0: &m0 {k: v}'];
  for (let i = 1; i < 40; i++) merges.push(`m${i}: &m${i} {<<: [*m${i - 1}, *m${i - 1}]}`);
  const head = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n';
  const cases = {
    bomb: head + bomb.join('\n'),
    merges: head + merges.join('\n'),
    cycle: 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\ndata: &d {self: *d}\n',
    deep: `a: ${'['.repeat(100000)}`,
    deepClosed: `a: ${'['.repeat(20000)}${']'.repeat(20000)}`,
    wide: `${head}data:\n${Array.from({ length: 30000 }, (_, i) => `  k${i}: 1`).join('\n')}\n`,
    documents: 'kind: A\n---\n'.repeat(5000),
    huge: `${head}data:\n  k: ${'x'.repeat(2_000_000)}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = Date.now();
    const out = k8s.validate(text, { image: image() });
    k8s.parse(text);
    k8s.summary(text);
    k8s.form(text, 0);
    assert.ok(Date.now() - started < 15000, `${name} took ${Date.now() - started}ms`);
    assert.ok(out.length <= 500, name);
    if (['bomb', 'merges', 'deep', 'documents', 'huge'].includes(name)) assert.ok(out.some((d) => d.severity === 'error'), name);
  }
  throwsKey(() => k8s.setValue(cases.huge, 0, ['metadata', 'name'], 'b'), 'k8s.err.tooLarge');
});

test('diagnostics are translated, located and sorted', () => {
  const text = deployment('name: web\nimage: nginx');
  const en = k8s.validate(text);
  const ko = k8s.validate(text, { lang: 'ko' });
  assert.deepEqual(en.map((d) => d.line), [...en.map((d) => d.line)].sort((a, b) => a - b));
  assert.notEqual(en[0].message, ko[0].message);
  const latest = en.find((d) => d.code === 'image-latest');
  assert.match(text.split('\n')[latest.line - 1], /image: nginx/);
  assert.ok(en.every((d) => d.doc === 0 && !d.message.startsWith('k8s.') && !/\{\w+\}/.test(d.message)));
});

test('every message has four languages with matching placeholders', async () => {
  const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [key, entry] of Object.entries(K8S_MESSAGES)) {
    assert.match(key, /^k8s\.(diag|err|field|group)\.\w+$/);
    assert.equal(entry.length, 4, key);
    for (const message of entry) {
      assert.ok(message, key);
      assert.equal(placeholders(message), placeholders(entry[0]), key);
    }
  }
  // Every key the core mentions exists.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/core/k8s.js', import.meta.url), 'utf8');
  for (const [, key] of source.matchAll(/'(k8s\.(?:diag|err|field|group)\.\w+)'/g)) assert.ok(Object.hasOwn(K8S_MESSAGES, key), key);
});
