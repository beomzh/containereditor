# Dockerfile 에디터

[English](README.md) | 한국어 | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**Dockerfile / Containerfile** 을 만들고 고치고, 검사하고, 결과 이미지를 미리 보고, 빌드합니다. 웹과 명령줄 모두 지원하며 외부 패키지를 쓰지 않습니다.

## 설치

Node.js 22 이상이 필요합니다. 빌드에는 Docker 또는 Podman 이 필요합니다.

```bash
npm install -g github:beomzh/dockereditor#v0.2.0
```

## 빠른 시작

```bash
dockereditor new node --lang ko
```

```bash
dockereditor validate --lang ko
```

```bash
dockereditor serve --allow-build --lang ko
```

출력된 주소를 엽니다. 가운데에서 작성하고, **① 이미지 확인**, **② 빌드** 순서로 씁니다.

## 웹 에디터

| 영역 | 기능 |
|---|---|
| 편집기 | 문법 색상, 문제 줄 표시, 메시지를 누르면 해당 줄로 이동 |
| 스테이지·설정 (왼쪽) | `FROM` 변경, `ARG` `ENV` `LABEL` `USER` `WORKDIR` `EXPOSE` `CMD` `ENTRYPOINT` 추가·수정·삭제, 스테이지 추가·삭제·분리·내보내기 |
| 결과 미리보기 | 스테이지 흐름, 실행 프로세스, 사용자, 환경 변수, 포트, 복사 파일, 레이어, `--build-arg` 시험 |
| 호환성 | 베이스 이미지가 linux/amd64, linux/arm64, windows/amd64, windows/arm64 에 있는지 |
| 빌드 | 실제 빌드. 결과 위치를 전후로 표시 |

언어: 영어(기본), 한국어, 중국어, 일본어.

## 명령줄

| 명령 | 설명 |
|---|---|
| `validate [파일]` | 문법과 모범 사례 검사 (`--strict`, `--json`) |
| `check [파일]` | `FROM` 이미지 존재 확인과 플랫폼 표. `--platform` 으로 지정한 플랫폼이 안 되면 실패 |
| `preview [파일]` | 스테이지와 결과 이미지 (`--online` 은 베이스 설정까지 읽음) |
| `new [템플릿]` | `node`, `go`, `python`, `java`, `windows`, `blank` |
| `add` / `set` / `remove` / `from` | 지시어 편집. 예: `set Dockerfile ENV NODE_ENV=production` |
| `stage add\|remove\|rename\|split\|extract` | 스테이지 작업 |
| `build [파일]` | Docker/Podman 빌드 (`--dry-run` 은 명령만 표시) |
| `serve` | 웹 에디터 시작 |

파일을 생략하면 `Dockerfile`, 없으면 `Containerfile` 입니다. 전체 옵션은 `dockereditor --help --lang ko`. 종료 코드: `0` 정상, `1` 문제 발견, `2` 사용 오류, `3` 빌드 실패.

## 빌드 결과가 만들어지는 위치

| `--output` | 결과물 | 위치 |
|---|---|---|
| `image` (기본) | `--tag` 이름의 이미지 | 엔진의 로컬 이미지 저장소. Docker Desktop·Podman machine 은 가상 머신 안 |
| `archive` | `docker load` 용 `.tar` | `--dest` 로 지정한 파일 |
| `folder` | 최종 스테이지의 파일들 | `--dest` 로 지정한 폴더 |

위치는 빌드 **시작 전에** 표시합니다. 기존 파일과 비어 있지 않은 폴더는 덮어쓰지 않습니다(CLI 는 `--force`). 원본 Dockerfile 은 바뀌지 않습니다.

## 지원 플랫폼

| 호스트 | 도구·테스트 | CI 실제 빌드 |
|---|---|---|
| Linux amd64 / arm64 | 지원 | 확인 |
| Windows amd64 | 지원 | 확인 (Windows 컨테이너: 이미지, tar) |
| Windows arm64 | 지원 | 미확인 (CI 러너에 Docker 없음) |

- Linux 이미지는 Linux 엔진, Windows 이미지는 Windows Docker 데몬이 필요합니다.
- Windows 데몬은 폴더 추출을 지원하지 않습니다.
- 다른 CPU 아키텍처 빌드에는 QEMU 에뮬레이션이 필요합니다.
- Podman 은 Docker 와 같은 방식으로 호출하지만 CI 에서 시험하지 않습니다.

## 원격 Linux 서버에서 쓰기

서버는 `127.0.0.1` 에서만 열립니다. 내 컴퓨터에서 터널을 연 뒤 서버에서 `dockereditor serve` 를 실행하세요.

```bash
ssh -L 4173:localhost:4173 user@server
```

## 한계

- 미리보기는 빌드 없이 파일을 해석합니다. `RUN` 이 만드는 파일·사용자는 보이지 않습니다.
- 자체 검사 규칙이라 Docker/Podman 의 모든 오류를 잡지는 못합니다.
- 로그인이 필요한 비공개 이미지는 확인할 수 없습니다.
- Docker Hub 는 익명 요청에 한도가 있습니다.
- 폼이나 `set` 으로 `ARG`/`ENV` 를 고치면 해당 지시어의 주석·따옴표 모양이 바뀔 수 있습니다.

## 보안

빌드는 Dockerfile 의 명령을 내 컴퓨터에서 실행합니다. 브라우저 빌드는 `--allow-build` 로 켜야 하며, 출력된 주소의 토큰이 필요하고, 작업 폴더 안으로 제한됩니다. 자세한 내용: [SECURITY.ko.md](SECURITY.ko.md).

## 라이선스

[Apache-2.0](LICENSE) © 2026 beomzh
