# Windows Setup

`mud-agent` depends on `tmux`, so Windows support goes through `WSL 2`.

## 1. Install WSL 2

Run this from an elevated PowerShell window:

```powershell
wsl --install -d Debian
# Restart Windows if prompted.
wsl --set-default-version 2
```

If you prefer the bootstrap script to trigger the install command for you, run:

```powershell
.\start.ps1 -InstallWsl
```

## 2. Finish first-run WSL setup

Launch WSL once and create your Linux username/password when prompted:

```powershell
wsl
```

Then update the distro:

```bash
sudo apt update
sudo apt upgrade -y
```

## 3. Install prerequisites inside WSL

`.\start.ps1` will auto-install missing `node`, `npm`, `tmux`, `luit`, and `telnet`.
If you want to do it manually instead:

```bash
if ! command -v curl >/dev/null 2>&1; then
  sudo apt install -y curl ca-certificates
fi
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs tmux telnet luit
```

## 4. Clone and start

You can keep the repo either on your Windows filesystem or inside the WSL home directory.

From PowerShell:

```powershell
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
.\start.ps1
```

From inside WSL:

```bash
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

`start.sh` will:

- install npm dependencies if `node_modules/` is missing
- create `config/local.secrets.json` from the example template if needed
- ensure tmux session `0` exists
- start the local UI server
- wait for `http://127.0.0.1:4315/api/health`
- open the browser automatically

## Notes

- WSL paths are available in Windows Explorer at `\\wsl$\Debian\home\...`
- When the repo is opened from a `\\wsl$` path, `start.ps1` targets that same distro automatically
- After a reboot, re-enter Linux with `wsl` from PowerShell
- In WSL, `start.sh` opens the Windows browser through `cmd.exe /c start`
