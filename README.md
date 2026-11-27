# Dockerfile Editor

[![CI](https://github.com/beomzh/dockereditor/actions/workflows/ci.yml/badge.svg)](https://github.com/beomzh/dockereditor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

English | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Write and edit a **Dockerfile / Containerfile**, check it, see what the image will look like, and build it — in the browser or from the command line. No third-party packages.

## Install

Needs Node.js 22 or later. Building also needs Docker or Podman.

```bash
npm install -g github:beomzh/dockereditor#v0.2.0
```

Or run from a clone:

```bash
git clone https://github.com/beomzh/dockereditor.git
```

```bash
cd dockereditor && node bin/dockereditor.js serve
```

## Quick start

```bash
dockereditor new node
```

```bash
dockereditor validate
```

```bash
dockereditor serve --allow-build
```

Open the URL it prints. The screen works in three steps: write in the middle, **① Check images**, then **② Build**.

## Web editor

| Area | What it does |
|---|---|
| Editor | Syntax colouring, problem lines, click a message to jump to it |
| Stages and settings (left) | Change `FROM`; add, edit, delete `ARG` `ENV` `LABEL` `USER` `WORKDIR` `EXPOSE` `CMD` `ENTRYPOINT`; add, delete, split or export stages |
| Result | Stage flow, final process, user, environment, ports, copied files, layers, `--build-arg` trial |
| Compatibility | Which base images exist for linux/amd64, linux/arm64, windows/amd64, windows/arm64 |
| Build | Real build, with the result location shown before and after |

Language: English (default), 한국어, 简体中文, 日本語.

## Command line

| Command | Description |
|---|---|
| `validate [file]` | Syntax and best-practice checks (`--strict`, `--json`) |
| `check [file]` | `FROM` images exist? Platform table. `--platform linux/amd64,linux/arm64` fails if one is unsupported |
| `preview [file]` | Stages and the resulting image (`--online` reads base image settings) |
| `new [template]` | `node`, `go`, `python`, `java`, `windows`, `blank` |
| `add` / `set` / `remove` / `from` | Edit instructions, for example `set Dockerfile ENV NODE_ENV=production` |
| `stage add\|remove\|rename\|split\|extract` | Work with stages |
| `build [file]` | Build with Docker or Podman (`--dry-run` shows the commands) |
| `serve` | Start the web editor |

`file` defaults to `Dockerfile`, then `Containerfile`. Use `--lang ko|zh|ja` or `DOCKEREDITOR_LANG`. `dockereditor --help` lists every option. Exit codes: `0` ok, `1` problems found, `2` usage error, `3` build failed.

## Where the build result goes

| `--output` | Result | Location |
|---|---|---|
| `image` (default) | Image tagged `--tag` | The engine's local image store. With Docker Desktop or Podman machine it is inside a VM |
| `archive` | `.tar` for `docker load` / `podman load` | The file given by `--dest` |
| `folder` | Files of the final stage | The folder given by `--dest` |

The location is printed **before** the build starts. Existing files and non-empty folders are not overwritten (CLI: `--force` to allow). Your Dockerfile is not modified.

```bash
dockereditor build --output folder --dest out/rootfs
```

## Platform support

| Host | Tool and tests | Real build in CI |
|---|---|---|
| Linux amd64 | yes | yes |
| Linux arm64 | yes | yes |
| Windows amd64 | yes | yes (Windows containers: image, archive) |
| Windows arm64 | yes | no (the CI runner has no Docker) |

- Linux images need a Linux engine; Windows images need a Windows Docker daemon.
- The Windows daemon cannot extract to a folder.
- Building for another CPU architecture needs QEMU emulation.
- Podman support follows the Docker command line but is not exercised in CI.

## Remote Linux server

The server listens on `127.0.0.1` only. From your own machine, tunnel to it:

```bash
ssh -L 4173:localhost:4173 user@server
```

Then run `dockereditor serve` on the server and open the printed URL locally.

## Limits

- The preview reads the file without building: files and users made by `RUN` are not shown.
- Checks are this project's own rules; they do not catch every Docker/Podman error.
- Private images that need a login cannot be checked.
- Docker Hub limits anonymous requests.
- Editing `ARG`/`ENV` through forms or `set` can change comments and quoting inside that instruction.

## Security

Building runs the commands in the Dockerfile on your machine. Browser builds are off unless you start with `--allow-build`, need the token in the printed URL, and are limited to the workspace folder. Details: [SECURITY.md](SECURITY.md).

## Development

```bash
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) © 2026 beomzh. Docker and Podman are trademarks of their owners; this project is not affiliated with them.
