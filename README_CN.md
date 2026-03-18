<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">中文</a> |
  <a href="./README_JA.md">日本語</a> |
  <a href="./README_FR.md">Français</a> |
  <a href="./README_ES.md">Español</a>
</p>

![aardwolf_play_sample](https://github.com/user-attachments/assets/e397507d-028f-46d3-a561-9d91730100bb)

# mud-agent

`mud-agent` 是一个本地控制界面，用于通过 AI 编码代理运行 MUD 会话。它结合了 `tmux`、启动脚本、按服务器划分的配置，以及一个小型本地 Web 服务器，使代理可以查看实时游戏输出，并通过现有窗格执行操作，而不是依赖临时拼接的 shell 管道。

## 使用说明

部分 MUD 禁止机器人、挂机或其他自动化行为。在将本仓库用于任何游戏之前，请先确认该游戏的规则，并确保你的使用方式符合要求。

## 支持内容

- 内置 Aardwolf 支持（`UTF-8`）
- 自定义 MUD 服务器定义，包括 `GBK`、`GB2312`、`BIG5` 等非 UTF-8 编码
- Codex、Claude Code、OpenClaw、OpenCode 等代理 CLI
- 直接使用 `tmux` 的工作流，以及运行在 `127.0.0.1` 上的本地浏览器界面

## 架构

```text
tmux session
  -> ./scripts 中的 MUD 启动脚本
  -> ./config 中的按服务器配置
  -> ./apps/server 中的本地控制服务
  -> 用于窗格输出、手动命令和交互式代理窗口的浏览器界面
```

浏览器界面是附加能力。你仍然可以直接使用 `tmux capture-pane` 和 `tmux send-keys` 来查看和控制会话。

## 依赖

- `tmux`
- `Node.js` 18+
- `npm`
- 如果你需要代理控制，至少安装一个受支持的代理 CLI

可选依赖，取决于目标服务器：

- `TinTin++`（`tt++`），用于内置的 Aardwolf 启动脚本
- `luit`，用于非 UTF-8 的 MUD
- `telnet`，用于基于 telnet 的 MUD

## 快速开始

### Linux

```bash
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### macOS

如果尚未安装，请先安装 `tmux`：

```bash
brew install tmux
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### Windows

先设置好 WSL，然后通过 PowerShell 启动：

```powershell
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
.\start.ps1
```

完整的 WSL 配置流程请参见 `SETUP_WINDOWS.md`。

`start.sh` 会在需要时安装依赖，根据示例模板创建 `config/local.secrets.json`，确保 tmux 会话 `0` 存在，启动本地 UI 服务器，并自动打开浏览器。
在使用脚本化登录之前，请先将你自己的凭据写入 `config/local.secrets.json`。

## 配置

- `config/servers.json`：内置服务器定义
- `config/agents.json`：内置代理定义
- `config/local.secrets.json`：仅本地使用的凭据文件，基于 `config/local.secrets.example.json`
- `config/local.servers.json`：可选的本地自定义服务器配置
- `walkthrough/`：代理可读取、也可写入的游戏说明与笔记

凭据属于本机私有状态，绝不能提交到仓库。

## 常见工作流

### Aardwolf

```bash
tmux new-window -t 0: -n aardwolf './scripts/aardwolf-tintin.sh'
tmux capture-pane -pt 0:aardwolf | tail -n 80
tmux send-keys -t 0:aardwolf 'look' Enter
```

### 非 UTF-8 MUD

对于 `GBK`、`GB2312`、`BIG5` 等类似服务器，请使用 `luit` 包装客户端；如果原始 `tmux send-keys` 不稳定，请改用 `./scripts/tmux-pane-send.sh`。

```bash
tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'
./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'
tmux capture-pane -pt 0:cjk_mud | tail -n 80
```

编码相关说明请参见 `SETUP.md`。游戏笔记和路线建议保存在 `walkthrough/` 中。

## Web 控制界面

使用以下命令启动本地服务：

```bash
npm run dev
```

它会绑定到 `127.0.0.1`，并提供：

- tmux 窗格查看
- 手动发送命令
- 基于 tmux 的交互式代理窗口
- 基于 `config/agents.json` 的代理启动配置

## 添加服务器

在 `config/servers.json` 或 `config/local.servers.json` 中添加服务器条目，包含：

- host 和 port
- encoding
- tmux session/window 设置
- launcher command
- 可选的 login command
- send mode（`tmux_keys` 或 `pane_tty`）

## 添加代理

在 `config/agents.json` 中添加代理条目，包含：

- CLI command 和 detection args
- 非交互运行参数
- 可选的交互式 tmux 设置
- 面向 TUI 代理的 ready/submit 匹配模式

## 仓库说明

- 这个仓库是作为源码仓库发布的，不是 npm 包。
- 根目录 `package.json` 保持为 `private`，因为该工作区用于本地运行。
- 如果你要发布清理后的副本，不要复用包含秘密信息的 git 历史。
- 代理应将长期有效的游戏笔记保存在 `walkthrough/` 中，而不是临时写到仓库根目录。

## 许可证

MIT。参见 `LICENSE`。
