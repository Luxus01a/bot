# 🎵 Bot Discord de musique (JavaScript / Node.js)

Bot Discord qui rejoint un salon vocal et joue de la musique depuis YouTube (lien ou recherche par titre), avec gestion de file d'attente.

Avantage vs la version Python : **pas besoin d'installer ffmpeg séparément** ni de PyNaCl — tout est géré par les paquets npm.

## 1. Installer Node.js

Télécharge et installe la version **LTS** depuis https://nodejs.org (coche "Add to PATH" si l'installeur le propose, normalement automatique sur Windows).

Vérifie dans un terminal :
```bash
node --version
npm --version
```

## 2. Créer l'application Discord

1. Va sur https://discord.com/developers/applications
2. **New Application** → donne un nom
3. Onglet **Bot** → **Add Bot** (ou **Reset Token** si le bot existe déjà)
4. Active le **Privileged Gateway Intent** : `MESSAGE CONTENT INTENT`
5. Copie le **Token**
6. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot`
   - Permissions : `Send Messages`, `Connect`, `Speak`, `Read Message History`, `Embed Links`
   - Ouvre l'URL générée pour inviter le bot sur ton serveur

## 3. Installation dans VSCode

Ouvre le dossier du projet dans VSCode (**Fichier → Ouvrir un dossier...**), puis dans le terminal intégré (`` Ctrl+` ``) :

```bash
npm install
```

Ça installe `discord.js`, `@discordjs/voice`, `play-dl` (streaming YouTube), et les libs audio nécessaires.

## 4. Configuration

Copie `.env.example` en `.env` et colle ton token :

```
DISCORD_TOKEN=ton_token_ici
PREFIX=!
```

## 5. Lancer le bot

```bash
npm start
```

ou directement :
```bash
node index.js
```

Tu dois voir `✅ Connecté en tant que ...` dans le terminal.

## 6. Commandes disponibles

| Commande | Alias | Description |
|---|---|---|
| `!play <lien ou titre>` | `!p` | Joue une musique (rejoint ton vocal si besoin) |
| `!skip` | `!s`, `!next` | Passe à la musique suivante |
| `!pause` | | Met en pause |
| `!resume` | `!unpause` | Reprend la lecture |
| `!stop` | | Arrête tout et vide la file |
| `!leave` | `!dc` | Le bot quitte le vocal |
| `!queue` | `!q` | Affiche la file d'attente |
| `!nowplaying` | `!np` | Affiche la musique en cours |
| `!volume <0-100>` | `!vol` | Change le volume |
| `!loop` | | Active/désactive la répétition |
| `!clear` | | Vide la file sans arrêter la lecture |
| `!remove <numéro>` | | Retire une musique précise de la file |

Un lien de **playlist YouTube** collé dans `!play` ajoute automatiquement toutes les vidéos de la playlist à la file.

## Dépannage

- **"Cannot find module ..."** → refais `npm install` dans le bon dossier (vérifie avec `dir`/`ls` que `package.json` est présent).
- **Le bot rejoint puis repart aussitôt** → vérifie que ton réseau n'bloque pas le trafic UDP (fréquent sur certains VPS/pare-feux d'entreprise) ; le message d'erreur dans le terminal te le dira.
- **Rien ne se passe avec `!play`** → vérifie dans le terminal les logs `[ERREUR ...]`, ils indiquent la cause précise (recherche YouTube échouée, permission manquante, etc).
- YouTube change parfois son fonctionnement interne ; si `play-dl` cesse de fonctionner, mets-le à jour :
  ```bash
  npm install play-dl@latest
  ```
