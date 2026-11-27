// Platform compatibility: Linux and Windows on amd64 and arm64.

export const PLATFORMS = ['linux/amd64', 'linux/arm64', 'windows/amd64', 'windows/arm64'];

const WINDOWS_IMAGE = /^mcr\.microsoft\.com\/(?:windows(?:\/|:|$)|.*(?:nanoserver|windowsservercore))|(?:nanoserver|windowsservercore)/i;

/** Which OS a stage targets: explicit --platform, then image name, parent stage and build platform. */
export function stageOs({ platform, baseRef, parentOs, target }) {
  const explicit = platform?.split('/')[0];
  if (explicit === 'linux' || explicit === 'windows') return explicit;
  if (WINDOWS_IMAGE.test(baseRef ?? '')) return 'windows';
  if (parentOs) return parentOs;
  return target?.startsWith('windows/') ? 'windows' : 'linux';
}

/** Does a published platform list ("linux/arm64/v8", ...) contain os/arch? */
export const hasPlatform = (published, wanted) => published.some((p) => p === wanted || p.startsWith(`${wanted}/`));

/**
 * @param sim     simulate() result
 * @param lookup  (baseRef) => registry result or undefined
 * @returns rows per external base image used by the target, and a per-platform summary.
 *          Cells are true (available), false (missing) or null (unknown).
 */
export function compatibility(sim, lookup, platforms = PLATFORMS) {
  const rows = [];
  for (const stage of sim.stages) {
    if (!sim.used.has(stage.index) || stage.parentIndex !== null || !stage.baseRef) continue;
    const result = lookup(stage.baseRef);
    const pinned = stage.rawPlatform ?? null;
    const buildHost = Boolean(pinned && /\$\{?BUILDPLATFORM/.test(pinned));
    const cells = platforms.map((wanted) => {
      if (stage.baseRef === 'scratch') return true;
      if (result?.status === 'not_found') return false;
      if (result?.status !== 'exists' || !result.platforms?.length) return null;
      return hasPlatform(result.platforms, pinned && !buildHost ? stage.platform : wanted);
    });
    rows.push({ index: stage.index, name: stage.name, ref: stage.baseRef, pinned, buildHost, cells });
  }

  // A final stage pinned to one platform cannot produce images for the others.
  let target = sim.stages[sim.targetIndex];
  while (target && target.parentIndex !== null && !target.rawPlatform) target = sim.stages[target.parentIndex];
  const fixed = target?.rawPlatform && !target.rawPlatform.includes('$') ? target.platform : null;

  const summary = platforms.map((wanted, i) => {
    if (fixed && !hasPlatform([fixed], wanted)) return false;
    // Stages that run on the build host do not limit the target platform.
    const relevant = rows.filter((r) => !r.buildHost).map((r) => r.cells[i]);
    if (relevant.includes(false)) return false;
    return relevant.includes(null) ? null : true;
  });
  return { platforms, rows, summary };
}
