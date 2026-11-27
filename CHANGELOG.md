# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versioning: [SemVer](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-27

First version: a local web editor for Dockerfile / Containerfile (Korean UI). Impact: optional

### Added
- **Editor with validation**: syntax, `USER`, `ARG`/`ENV` and stage reference checks with line numbers.
- **Stage tools**: add, remove, split and extract stages; form editing of settings.
- **FROM check**: image and tag lookup in the registry.
- **Result preview**: stage flow, final process, environment, files and layers without running a build.
