<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">中文</a> |
  <a href="./README_JA.md">日本語</a> |
  <a href="./README_FR.md">Français</a> |
  <a href="./README_ES.md">Español</a>
</p>

![aardwolf_play_sample](https://github.com/user-attachments/assets/e397507d-028f-46d3-a561-9d91730100bb)

# mud-agent

`mud-agent` est une interface de contrôle locale pour exécuter des sessions MUD via des agents de codage IA. Le projet combine `tmux`, des scripts de lancement, une configuration par serveur et un petit serveur Web local afin que les agents puissent inspecter la sortie du jeu en direct et agir via des volets existants plutôt qu'au moyen de pipes shell improvisés.

## Avertissement d'utilisation

Certains MUD interdisent les bots, le jeu AFK ou d'autres formes d'automatisation. Avant d'utiliser ce dépôt avec un jeu, vérifiez ses règles et assurez-vous que votre usage les respecte.

## Fonctionnalités prises en charge

- Prise en charge intégrée d'Aardwolf (`UTF-8`)
- Définitions de serveurs MUD personnalisés, y compris des encodages non UTF-8 comme `GBK`, `GB2312` et `BIG5`
- CLI d'agents comme Codex, Claude Code, OpenClaw et OpenCode
- Flux de travail `tmux` directs et interface navigateur locale sur `127.0.0.1`

## Architecture

```text
tmux session
  -> scripts de lancement MUD dans ./scripts
  -> configuration par serveur dans ./config
  -> serveur de contrôle local dans ./apps/server
  -> interface navigateur pour la sortie des volets, les commandes manuelles et les fenêtres d'agents interactifs
```

L'interface navigateur est un ajout, pas un remplacement. Vous pouvez toujours inspecter et contrôler les sessions directement avec `tmux capture-pane` et `tmux send-keys`.

## Prérequis

- `tmux`
- `Node.js` 18+
- `npm`
- Au moins une CLI d'agent prise en charge si vous voulez le contrôle par agent

Optionnel selon le serveur :

- `TinTin++` (`tt++`) pour le lanceur Aardwolf fourni
- `luit` pour les MUD non UTF-8
- `telnet` pour les MUD basés sur telnet

## Démarrage rapide

### Linux

```bash
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### macOS

Installez d'abord `tmux` si nécessaire :

```bash
brew install tmux
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### Windows

Configurez d'abord WSL, puis lancez via PowerShell :

```powershell
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
.\start.ps1
```

Voir `SETUP_WINDOWS.md` pour le processus complet d'installation WSL.

`start.sh` installera les dépendances si nécessaire, créera `config/local.secrets.json` à partir du modèle d'exemple, vérifiera l'existence de la session tmux `0`, démarrera le serveur UI local et ouvrira automatiquement le navigateur.
Modifiez `config/local.secrets.json` avec vos propres identifiants avant d'utiliser les connexions scriptées.

## Configuration

- `config/servers.json` : définitions de serveurs intégrées
- `config/agents.json` : définitions d'agents intégrées
- `config/local.secrets.json` : identifiants locaux uniquement, basés sur `config/local.secrets.example.json`
- `config/local.servers.json` : serveurs personnalisés locaux optionnels
- `walkthrough/` : notes de jeu lisibles et modifiables par les agents

Les identifiants sont un état local de la machine et ne doivent jamais être commités.

## Flux de travail courants

### Aardwolf

```bash
tmux new-window -t 0: -n aardwolf './scripts/aardwolf-tintin.sh'
tmux capture-pane -pt 0:aardwolf | tail -n 80
tmux send-keys -t 0:aardwolf 'look' Enter
```

### MUD non UTF-8

Pour les serveurs `GBK`, `GB2312`, `BIG5` ou similaires, enveloppez le client avec `luit` et utilisez `./scripts/tmux-pane-send.sh` lorsque `tmux send-keys` n'est pas fiable.

```bash
tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'
./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'
tmux capture-pane -pt 0:cjk_mud | tail -n 80
```

Voir `SETUP.md` pour les notes sur les encodages. Conservez les notes de jeu et les itinéraires dans `walkthrough/`.

## Interface Web de contrôle

Démarrez le serveur local avec :

```bash
npm run dev
```

Il se lie à `127.0.0.1` et fournit :

- inspection des volets tmux
- envoi manuel de commandes
- fenêtres d'agents interactifs adossées à tmux
- configuration de lancement des agents basée sur `config/agents.json`

## Ajouter un serveur

Ajoutez une entrée de serveur à `config/servers.json` ou `config/local.servers.json` avec :

- host et port
- encoding
- paramètres tmux session/window
- launcher command
- login command optionnelle
- send mode (`tmux_keys` ou `pane_tty`)

## Ajouter un agent

Ajoutez une entrée d'agent à `config/agents.json` avec :

- CLI command et detection args
- arguments d'exécution non interactive
- paramètres tmux interactifs optionnels
- motifs ready/submit pour les agents adossés à une TUI

## Notes sur le dépôt

- Ce dépôt est destiné à être publié comme code source, pas comme paquet npm.
- Le `package.json` racine reste `private` car l'espace de travail est destiné à un usage local.
- Si vous publiez une copie nettoyée, ne réutilisez pas un historique git contenant des secrets.
- Les agents doivent conserver les notes de jeu durables dans `walkthrough/`, pas dans des fichiers ad hoc à la racine.

## Licence

MIT. Voir `LICENSE`.
