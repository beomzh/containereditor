# Security Policy

English | [한국어](SECURITY.ko.md) | [简体中文](SECURITY.zh-CN.md) | [日本語](SECURITY.ja.md)

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include the version, operating system and architecture, and steps to reproduce.

## Supported versions

Only the latest minor release receives security fixes until 1.0.

## Security model

| Area | Behaviour |
|---|---|
| Network exposure | The web server listens on `127.0.0.1` only and rejects other `Host` names. There is no option to expose it. |
| Builds from the browser | Off unless started with `--allow-build`. Require a random token (passed in the URL fragment, sent as a custom header), reject other origins, accept JSON only. |
| Paths | Browser builds keep the context and the destination inside `--workspace`, following symlinks. Existing files and non-empty folders are never overwritten. |
| Commands | Docker/Podman are started without a shell. Your Dockerfile is written to a temporary file that is removed after the build. |
| Outbound requests | Only when you check images (and `preview --online`): the registry named in `FROM`, its token service (HTTPS only), and Docker Hub for tag suggestions. No telemetry. |
| Credentials | No registry login is read, stored or sent by this tool. Docker/Podman use their own configuration during builds. |
| Dependencies | No third-party runtime packages. |

## What it does not protect against

- **A build runs the commands in the Dockerfile.** Build only files you trust.
- The workspace limit applies to the paths this tool chooses, not to what a build does inside the engine.
- Checking an image contacts whatever registry host the file names, including hosts on your network. Do not check files you do not trust.
- Anyone who has the printed URL with the token, and can reach your local port, can build in the workspace. Do not share it.
- Other users of the same machine who can reach `localhost` can use the image check. Builds still need the token.
