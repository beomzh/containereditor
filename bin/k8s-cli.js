// `containereditor k8s <new|validate|check|set> ...`

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as YAML from 'yaml';
import { createK8s, KINDS } from '../public/core/k8s.js';
import { simulate } from '../public/core/simulator.js';
import { LocalizedError } from '../public/core/i18n.js';

const k8s = createK8s(YAML);

/** What the manifest checks need to know about the image built from a Dockerfile. */
export function imageInfo(dockerfile) {
  const sim = simulate(dockerfile);
  const final = sim.stages[sim.targetIndex];
  if (!final) return null;
  const argv = (c) => (!c ? null : c.form === 'exec' ? c.value : ['/bin/sh', '-c', c.value]);
  return {
    expose: [...final.state.expose], user: final.state.user,
    entrypoint: argv(final.state.entrypoint), cmd: argv(final.state.cmd), known: final.baseKnown,
  };
}

/** "spec.template.spec.containers.0.image" or with quoted keys: metadata.labels."app.kubernetes.io/name" */
export function parsePath(text) {
  const parts = [...text.matchAll(/"([^"]*)"|([^."]+)/g)].map((m) => m[1] ?? (/^\d+$/.test(m[2]) ? Number(m[2]) : m[2]));
  if (!parts.length) throw new LocalizedError('cli.missingArg', { what: 'path' });
  return parts;
}

export async function k8sCommand(args, { values, t, out, err, raw, cwd, load, writeNew, writeBack, checkImage, need }) {
  const [action, ...rest] = args;

  if (action === 'new') {
    const kind = KINDS.find((k) => k.toLowerCase() === need(rest[0], KINDS.join(', ')).toLowerCase());
    if (!kind) throw new LocalizedError('cli.missingArg', { what: KINDS.join(', ') });
    const text = k8s.template(kind, values.name ? { name: values.name } : {});
    if (values.stdout) raw(text);
    else await writeNew(values.out ?? 'k8s.yaml', text);
    return 0;
  }

  if (action === 'validate') {
    const file = await load(rest[0] ?? 'k8s.yaml');
    const image = values.dockerfile ? imageInfo(await readFile(resolve(cwd, values.dockerfile), 'utf8')) : null;
    const diagnostics = k8s.validate(file.text, { lang: values.lang, image });
    const count = (s) => diagnostics.filter((d) => d.severity === s).length;
    if (values.json) out(JSON.stringify({ file: file.name, diagnostics }, null, 2));
    else {
      for (const d of diagnostics) out(`${file.name}:${d.line}: ${t(`ui.${d.severity}`)}: ${d.message}`);
      out(t('cli.summary', { path: file.name, e: count('error'), w: count('warning'), i: count('info') }));
    }
    return count('error') || (values.strict && count('warning')) ? 1 : 0;
  }

  if (action === 'check') {
    const file = await load(rest[0] ?? 'k8s.yaml');
    const refs = [...new Set(k8s.images(file.text).map((i) => i.ref))];
    if (!refs.length) { out(t('ui.nothingToCheck')); return 0; }
    let failed = false;
    for (const ref of refs) {
      const result = await checkImage(ref, values.platform?.split(',')[0] ?? 'linux/amd64');
      if (result.status === 'exists' && !result.platformMissing) out(`✓ ${t('ui.exists', { ref })}`);
      else if (result.status === 'blocked') out(`? ${ref}: ${t(result.key, result.params)}`);
      else {
        failed = true;
        err(`✗ ${ref}: ${result.platformMissing ? t('diag.platformMissing', { ref, platform: values.platform ?? 'linux/amd64' }) : t(result.key, result.params)}`);
      }
    }
    return failed ? 1 : 0;
  }

  if (action === 'set') {
    const file = await load(need(rest[0], 'file'));
    const path = parsePath(need(rest[1], 'path'));
    const given = need(rest[2], 'value');
    // Plain YAML scalars keep their type: 3 is a number, true a boolean, "3" a string.
    let value = given;
    if (/^(true|false|-?\d+)$/.test(given)) value = YAML.parse(given);
    else if (/^".*"$/.test(given)) value = given.slice(1, -1);
    const result = k8s.setValue(file.text, Number(values.doc ?? 0), path, value);
    if (values.stdout) raw(result);
    else await writeBack(file, result);
    return 0;
  }

  throw new LocalizedError('cli.unknownCommand', { value: `k8s ${action ?? ''}` });
}
