# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versioning: [SemVer](https://semver.org).

## [Unreleased]

## [0.3.0] - 2026-11-27

Compared with 0.2.0: renamed to containereditor, Kubernetes YAML editing, and running with Docker alone. Impact: optional

### Breaking
- **The project is now `containereditor`** (was `dockereditor`): command, repository, image name, environment variables (`CONTAINEREDITOR_*`) and browser storage. Reinstall; content autosaved in the browser by 0.2.0 does not carry over.

### Security
- **Container mode listens on all container interfaces.** Outside a container nothing changes. Publish the port on `127.0.0.1` only; see `SECURITY.md`.

### Added
- **Kubernetes YAML editor** (web and `containereditor k8s`): forms and checks for Deployment, StatefulSet, Job, CronJob, Service, ConfigMap, Secret, Ingress, Route and PersistentVolumeClaim, linked with the Dockerfile.
- **One runtime dependency**: `yaml` 2.9.1 (ISC).
- **`Dockerfile` for the editor itself**: web editor and command line without Node.js or npm, with a Docker quick start in four languages.
- **Step-by-step quick start** in the README, with a troubleshooting table.
- **Result path hint** inside the container: `/work` is the mounted folder.
- `serve` now exits promptly on Ctrl+C or `docker stop`.

Known limit: folder output fails on Docker Desktop bind mounts; use archive output there.

## [0.2.0] - 2026-11-27

Compared with 0.1.0: real builds, a command line, platform compatibility checks, four languages with English as the default, and project security files. Impact: optional

### Breaking
- **English is now the default language** (0.1.0 was Korean only). Choose 한국어 in the header or use `--lang ko`.
- **Node.js 22 or later** is required.

### Security
- **Browser builds are opt-in** (`--allow-build`) and require a token, same origin, JSON requests and paths inside the workspace.
- **Stricter response headers**: framing and referrers are blocked.
- **Image checks contact only known public registries** (and token services). 0.1.0 contacted any host named in `FROM`. Add your own with `DOCKEREDITOR_REGISTRIES`.

### Added
- **Real builds** with Docker or Podman: local image, image archive or files in a folder. The result location is shown before and after the build.
- **Command line** `dockereditor`: validate, check, preview, new, add, set, remove, from, stage, build, serve.
- **Platform compatibility** table for linux and windows on amd64 and arm64.
- **Windows Dockerfiles**: backslash paths, `cmd` shell, Windows-only checks and a template.
- **Windows Docker daemon support**: builds work when the project is on a different drive than the temporary folder.
- **Languages**: English, Korean, Simplified Chinese, Japanese in the web UI, CLI, README and security policy.
- **Project files**: Apache-2.0 license, security policy, CI on Linux and Windows (amd64, arm64), CodeQL.

### Changed
- The web UI has Result, Compatibility and Build tabs and numbered main steps.
- Selecting an unnamed earlier stage in the Build tab now reports that it cannot be a target instead of building the last stage.

## [0.1.0] - 2026-11-27

First version: a local web editor for Dockerfile / Containerfile (Korean UI). Impact: optional

### Added
- **Editor with validation**: syntax, `USER`, `ARG`/`ENV` and stage reference checks with line numbers.
- **Stage tools**: add, remove, split and extract stages; form editing of settings.
- **FROM check**: image and tag lookup in the registry.
- **Result preview**: stage flow, final process, environment, files and layers without running a build.

[Unreleased]: https://github.com/beomzh/containereditor/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/beomzh/containereditor/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/beomzh/containereditor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/beomzh/containereditor/releases/tag/v0.1.0
