<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">中文</a> |
  <a href="./README_JA.md">日本語</a> |
  <a href="./README_FR.md">Français</a> |
  <a href="./README_ES.md">Español</a>
</p>

![aardwolf_play_sample](https://github.com/user-attachments/assets/e397507d-028f-46d3-a561-9d91730100bb)

# mud-agent

`mud-agent` es una superficie de control local para ejecutar sesiones de MUD mediante agentes de programación con IA. Combina `tmux`, scripts de arranque, configuración por servidor y un pequeño servidor web local para que los agentes puedan inspeccionar la salida del juego en vivo y actuar a través de paneles existentes en lugar de usar tuberías de shell improvisadas.

## Aviso de uso

Algunos MUD prohíben los bots, el juego AFK u otras formas de automatización. Antes de usar este repositorio con cualquier juego, revisa sus reglas y asegúrate de que tu uso las cumpla.

## Qué soporta

- Soporte integrado para Aardwolf (`UTF-8`)
- Definiciones personalizadas de servidores MUD, incluidos encodings no UTF-8 como `GBK`, `GB2312` y `BIG5`
- CLIs de agentes como Codex, Claude Code, OpenClaw y OpenCode
- Flujos de trabajo directos con `tmux` y una interfaz local en el navegador sobre `127.0.0.1`

## Arquitectura

```text
tmux session
  -> scripts de arranque de MUD en ./scripts
  -> configuración por servidor en ./config
  -> servidor de control local en ./apps/server
  -> interfaz de navegador para salida de paneles, comandos manuales y ventanas de agentes interactivos
```

La interfaz del navegador es adicional. Puedes seguir inspeccionando y controlando las sesiones directamente con `tmux capture-pane` y `tmux send-keys`.

## Requisitos

- `tmux`
- `Node.js` 18+
- `npm`
- Al menos una CLI de agente compatible si quieres control mediante agentes

Opcional, según el servidor:

- `TinTin++` (`tt++`) para el lanzador integrado de Aardwolf
- `luit` para MUDs no UTF-8
- `telnet` para MUDs basados en telnet

## Inicio rápido

### Linux

```bash
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### macOS

Instala `tmux` primero si hace falta:

```bash
brew install tmux
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### Windows

Configura WSL primero y luego inicia desde PowerShell:

```powershell
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
.\start.ps1
```

Consulta `SETUP_WINDOWS.md` para el flujo completo de configuración de WSL.

`start.sh` instalará dependencias si hace falta, creará `config/local.secrets.json` a partir de la plantilla de ejemplo, verificará que exista la sesión tmux `0`, iniciará el servidor UI local y abrirá el navegador automáticamente.
Edita `config/local.secrets.json` con tus propias credenciales antes de usar inicios de sesión automatizados.

## Configuración

- `config/servers.json`: definiciones integradas de servidores
- `config/agents.json`: definiciones integradas de agentes
- `config/local.secrets.json`: credenciales solo locales, basadas en `config/local.secrets.example.json`
- `config/local.servers.json`: servidores locales personalizados opcionales
- `walkthrough/`: notas de juego legibles y editables por agentes

Las credenciales son estado local de la máquina y nunca deben confirmarse en git.

## Flujos de trabajo comunes

### Aardwolf

```bash
tmux new-window -t 0: -n aardwolf './scripts/aardwolf-tintin.sh'
tmux capture-pane -pt 0:aardwolf | tail -n 80
tmux send-keys -t 0:aardwolf 'look' Enter
```

### MUDs no UTF-8

Para servidores `GBK`, `GB2312`, `BIG5` o similares, envuelve el cliente con `luit` y usa `./scripts/tmux-pane-send.sh` cuando `tmux send-keys` no sea fiable.

```bash
tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'
./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'
tmux capture-pane -pt 0:cjk_mud | tail -n 80
```

Consulta `SETUP.md` para las notas sobre encoding. Guarda notas de juego y rutas en `walkthrough/`.

## Superficie web de control

Inicia el servidor local con:

```bash
npm run dev
```

Se enlaza a `127.0.0.1` y ofrece:

- inspección de paneles tmux
- envío manual de comandos
- ventanas interactivas de agentes respaldadas por tmux
- configuración de arranque de agentes basada en `config/agents.json`

## Añadir un servidor

Añade una entrada de servidor en `config/servers.json` o `config/local.servers.json` con:

- host y port
- encoding
- ajustes de tmux session/window
- launcher command
- login command opcional
- send mode (`tmux_keys` o `pane_tty`)

## Añadir un agente

Añade una entrada de agente en `config/agents.json` con:

- CLI command y detection args
- argumentos para ejecución no interactiva
- ajustes opcionales de tmux interactivo
- patrones ready/submit para agentes con TUI

## Notas del repositorio

- Este repositorio está pensado para publicarse como código fuente, no como paquete npm.
- El `package.json` raíz sigue siendo `private` porque el workspace es para uso local.
- Si publicas una copia saneada, no reutilices un historial git que contenga secretos.
- Los agentes deben guardar notas de juego duraderas en `walkthrough/`, no en archivos improvisados en la raíz.

## Licencia

MIT. Consulta `LICENSE`.
