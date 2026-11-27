# Container Editor

[English](README.md) | [한국어](README.ko.md) | 简体中文 | [日本語](README.ja.md)

编写和修改 **Dockerfile / Containerfile**，检查语法，预览最终镜像并执行构建。支持网页和命令行，仅依赖一个第三方包（`yaml`）。 还可以编辑 **Kubernetes YAML**，并对照 Dockerfile 进行检查。

## 快速开始

只需安装并运行 Docker。Linux、macOS、Windows 命令相同。

### 1. 获取编辑器（只需一次）

```bash
docker build -t containereditor https://github.com/beomzh/containereditor.git#main
```

大约需要一分钟，无需下载或克隆任何内容。

### 2. 启动

```bash
docker run --rm --init -p 127.0.0.1:4173:4173 containereditor
```

保持此终端打开。按 `Ctrl+C` 停止。

### 3. 在浏览器中打开

访问 **http://localhost:4173/?lang=zh**，其中已有一个示例 Dockerfile。

- 用 **打开** 载入自己的 Dockerfile，或直接在中间编写。
- **① 检查镜像** 会告诉你 `FROM` 镜像是否存在。
- 右侧显示镜像的最终样子。
- **保存** 会下载文件。

### 遇到问题时

| 看到的信息 | 解决办法 |
|---|---|
| `Cannot connect to the Docker daemon` | 启动 Docker。Linux 上出现 `permission denied` 时使用 `sudo docker …` |
| `port is already allocated` / `address already in use` | 换端口：`-p 127.0.0.1:8080:4173`，然后访问 http://localhost:8080 |
| 页面打不开 | 确认第 2 步的终端仍在运行 |

## 可选：处理本地目录中的文件

检查当前目录的 `Dockerfile`：

```bash
docker run --rm -v "$PWD:/work" containereditor validate --lang zh
```

**在编辑器中构建。** Linux：

```bash
docker run --rm --init -p 127.0.0.1:4173:4173 \
  -v "$PWD:/work" --user "$(id -u):$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  containereditor serve --allow-build --lang zh
```

使用 Docker Desktop 的 macOS、Windows（PowerShell 请写成一行并使用 `${PWD}`）：

```bash
docker run --rm --init -p 127.0.0.1:4173:4173 -v "$PWD:/work" -v /var/run/docker.sock:/var/run/docker.sock --group-add 0 containereditor serve --allow-build --lang zh
```

完整打开输出的网址（以 `#token=…` 结尾），然后使用 **② 构建** 标签页。结果请选择 **本地镜像** 或 **镜像文件 (.tar)**。

> **Docker 套接字可以完全控制宿主机。** 仅在构建时挂载，且只构建可信文件。请保留 `-p` 中的 `127.0.0.1:`，否则同一网络的其他人可以访问。

## 不用 Docker（npm）

需要 Node.js 22 或更高版本。

```bash
npm install -g github:beomzh/containereditor#v0.3.0
```

```bash
containereditor serve --lang zh
```

然后打开 http://localhost:4173。其他命令见[命令行](#命令行)。

## 网页编辑器

| 区域 | 功能 |
|---|---|
| 编辑器 | 语法着色、问题行标记、点击消息跳转 |
| 阶段与设置（左侧） | 修改 `FROM`；添加、修改、删除 `ARG` `ENV` `LABEL` `USER` `WORKDIR` `EXPOSE` `CMD` `ENTRYPOINT`；添加、删除、拆分、导出阶段 |
| 结果预览 | 阶段流程、启动进程、用户、环境变量、端口、复制的文件、层、试用 `--build-arg` |
| 兼容性 | 基础镜像是否支持 linux/amd64、linux/arm64、windows/amd64、windows/arm64 |
| 构建 | 实际构建，构建前后都显示结果位置 |

语言：英语（默认）、韩语、中文、日语。

## Kubernetes YAML

点击网页编辑器顶部的 **Kubernetes**。填写左侧表单，中间的 YAML 随之改变，注释会保留。

- 支持类型：Deployment, StatefulSet, Job, CronJob, Service, ConfigMap, Secret, Ingress, Route (OpenShift), PersistentVolumeClaim
- 检查常见错误：匹配不到任何对象的 selector、缺少资源限制、未指定标签的镜像、引用不存在的对象
- **与 Dockerfile 联动：** `containerPort` 对照 `EXPOSE`，`runAsNonRoot` 对照 `USER`，以及 `command`/`args` 覆盖的内容
- Secret 值以掩码显示，且不会保存在浏览器中。

```bash
containereditor k8s new Deployment
```

```bash
containereditor k8s validate k8s.yaml --dockerfile Dockerfile
```

这些是常见错误检查，并非完整的集群模式校验。编辑器不会连接集群。

## 命令行

| 命令 | 说明 |
|---|---|
| `validate [文件]` | 语法和最佳实践检查（`--strict`、`--json`） |
| `check [文件]` | 检查 `FROM` 镜像是否存在并给出平台表；`--platform` 指定的平台不支持时失败 |
| `preview [文件]` | 查看阶段和最终镜像（`--online` 读取基础镜像设置） |
| `new [模板]` | `node`、`go`、`python`、`java`、`windows`、`blank` |
| `add` / `set` / `remove` / `from` | 编辑指令，例如 `set Dockerfile ENV NODE_ENV=production` |
| `stage add\|remove\|rename\|split\|extract` | 阶段操作 |
| `build [文件]` | 用 Docker/Podman 构建（`--dry-run` 仅显示命令） |
| `serve` | 启动网页编辑器 |

省略文件时依次查找 `Dockerfile`、`Containerfile`。全部选项见 `containereditor --help --lang zh`。退出码：`0` 正常，`1` 发现问题，`2` 用法错误，`3` 构建失败。

## 构建结果在哪里

| `--output` | 结果 | 位置 |
|---|---|---|
| `image`（默认） | 以 `--tag` 命名的镜像 | 引擎的本地镜像存储；Docker Desktop、Podman machine 时位于虚拟机内 |
| `archive` | 供 `docker load` 使用的 `.tar` | `--dest` 指定的文件 |
| `folder` | 最终阶段的文件 | `--dest` 指定的目录 |

构建**开始前**就会显示位置。不会覆盖已有文件和非空目录（CLI 可用 `--force`）。原始 Dockerfile 不会被修改。

## 平台支持

| 主机 | 工具与测试 | CI 实际构建 |
|---|---|---|
| Linux amd64 / arm64 | 支持 | 已验证 |
| Windows amd64 | 支持 | 已验证（Windows 容器：镜像、归档） |
| Windows arm64 | 支持 | 未验证（CI 运行器没有 Docker） |

- Linux 镜像需要 Linux 引擎，Windows 镜像需要 Windows Docker 守护进程。
- Windows 守护进程不支持导出到目录。
- 构建其他 CPU 架构需要 QEMU 模拟。
- Podman 按与 Docker 相同的方式调用，但未在 CI 中测试。

## 在远程 Linux 服务器上使用

服务器只监听 `127.0.0.1`。先在本机建立隧道，再在服务器上运行 `containereditor serve`。

```bash
ssh -L 4173:localhost:4173 user@server
```

## 限制

- 预览不执行构建，看不到 `RUN` 创建的文件和用户。
- 检查规则为本项目自定义，无法发现 Docker/Podman 的所有错误。
- 无法检查需要登录的私有镜像。
- 只连接常见的公共仓库。自建仓库：`CONTAINEREDITOR_REGISTRIES=harbor.example.com containereditor check`
- Docker Hub 限制匿名请求次数。
- 通过表单或 `set` 修改 `ARG`/`ENV` 时，该指令内的注释和引号形式可能改变。

## 安全

构建会在你的机器上执行 Dockerfile 中的命令。浏览器构建默认关闭，需要 `--allow-build`、输出网址中的令牌，且限制在工作目录内。详见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 许可证

[Apache-2.0](LICENSE) © 2026 beomzh
