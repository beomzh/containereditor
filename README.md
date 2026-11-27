# Dockerfile Editor

[![CI](https://github.com/beomzh/dockereditor/actions/workflows/ci.yml/badge.svg)](https://github.com/beomzh/dockereditor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

English | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Write and edit a **Dockerfile / Containerfile**, check it, see what the image will look like, and build it — in the browser or from the command line. No third-party packages.

## Quick start

You only need Docker, installed and running. The commands are the same on Linux, macOS and Windows.

### 1. Get the editor (once)

```bash
docker build -t dockereditor https://github.com/beomzh/dockereditor.git#main
```

It takes a minute or so. You do not need to download or clone anything.

### 2. Start it

```bash
docker run --rm --init -p 127.0.0.1:4173:4173 dockereditor
```

Leave this terminal open. `Ctrl+C` stops the editor.

### 3. Open it in your browser

Go to **http://localhost:4173**. A sample Dockerfile is already there.

- **Open** loads your own Dockerfile; or just type in the middle.
- **① Check images** tells you whether each `FROM` image exists.
- The right side shows what the image will look like.
- **Save** downloads the file.

### If it does not work

| What you see | What to do |
|---|---|
| `Cannot connect to the Docker daemon` | Start Docker. On Linux, `permission denied` means: use `sudo docker …` |
| `port is already allocated` / `address already in use` | Use another port: `-p 127.0.0.1:8080:4173`, then open http://localhost:8080 |
| The page does not load | Check that the terminal from step 2 is still running |

## Optional: work with files in your folder

Check the `Dockerfile` in the current folder:

```bash
docker run --rm -v "$PWD:/work" dockereditor validate
```

**Build from the editor.** Linux:

```bash
docker run --rm --init -p 127.0.0.1:4173:4173 \
  -v "$PWD:/work" --user "$(id -u):$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  dockereditor serve --allow-build
```

macOS or Windows with Docker Desktop (PowerShell: write it on one line and use `${PWD}`):

```bash
docker run --rm --init -p 127.0.0.1:4173:4173 -v "$PWD:/work" -v /var/run/docker.sock:/var/run/docker.sock --group-add 0 dockereditor serve --allow-build
```

Open the whole address it prints (it ends in `#token=…`), then use the **② Build** tab. For the result choose **Local image** or **Image file (.tar)**.

> **The Docker socket gives full control of the host.** Mount it only to build, and build only files you trust. Keep `127.0.0.1:` in `-p`, or others on your network can reach the editor.

## Without Docker (npm)

Needs Node.js 22 or later.

```bash
npm install -g github:beomzh/dockereditor#v0.2.0
```

```bash
dockereditor serve
```

Then open http://localhost:4173. More commands are under [Command line](#command-line).

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
- Only well-known public registries are contacted. For your own registry: `DOCKEREDITOR_REGISTRIES=harbor.example.com dockereditor check`.
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
