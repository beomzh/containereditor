# Contributing

## Development

Node.js 22 or later. There is nothing to install.

```bash
npm test
```

```bash
node bin/dockereditor.js serve --allow-build
```

## Layout

| Path | Content |
|---|---|
| `public/core/` | Parser, validator, simulator, editing, platforms, messages. Shared by browser, CLI and tests |
| `public/` | Web UI |
| `server/` | Web server, registry client, builder |
| `bin/` | Command line |
| `test/` | `node --test` |

## Workflow

1. Never push directly to `main`. Branch: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
2. Commit messages: `type(scope): title`. Add a `CHANGELOG.md` entry with each change.
3. Open a pull request against `main`; CI must pass. Merge with squash.
4. Release: set `version` in `package.json`, move `[Unreleased]` to the version in `CHANGELOG.md`, tag `vX.Y.Z` on `main` and create a GitHub release.

## Rules

- Messages go in `public/core/i18n.js` with all four languages (a test enforces it).
- No third-party runtime dependencies.
- Anything that runs commands, writes files or accepts requests needs a test and must keep [SECURITY.md](SECURITY.md) true.
- Contributions are licensed under Apache-2.0.
