# MCP TrackCandidatures

Serveur MCP (stdio, **zéro dépendance**, Node 18+) qui permet à un agent
(OpenCode, Claude, …) de lire et modifier vos candidatures via votre
**compte cloud** — même quand l'application est fermée.

## Prérequis

- Un compte cloud créé et connecté au moins une fois dans l'application
  (pour que la ligne de données existe côté Supabase).
- Node 18+ (`node -v`).

## Configuration OpenCode

Ajoutez le serveur, puis déclarez vos identifiants **par référence**
(jamais en clair dans le fichier) :

```sh
opencode mcp add trackcandidatures --global -- node "C:\Users\mike\Desktop\grenier\Mon univers\mes suivits de candidatures\mcp\server.js"
```

Puis dans `~/.config/opencode/opencode.json`, section du serveur :

```jsonc
{
  "mcp": {
    "servers": {
      "trackcandidatures": {
        "type": "local",
        "command": ["node", "C:\\Users\\mike\\Desktop\\grenier\\Mon univers\\mes suivits de candidatures\\mcp\\server.js"],
        "environment": {
          "TC_EMAIL": "{env:TC_EMAIL}",
          "TC_PASSWORD": "{env:TC_PASSWORD}"
        }
      }
    }
  }
}
```

Et dans votre environnement (jamais dans le fichier) :

```sh
# Windows PowerShell (profil) :
$env:TC_EMAIL = "vous@exemple.fr"
$env:TC_PASSWORD = "votre-mot-de-passe"
```

Vérifiez avec `opencode mcp list` : le serveur doit passer à `connected`.
Les outils apparaissent sous `tools.trackcandidatures.*`.

## Test de fumée (contre le vrai backend, lecture seule)

```sh
$env:TC_EMAIL = "vous@exemple.fr"
$env:TC_PASSWORD = "votre-mot-de-passe"
node smoke.js
# SMOKE OK (lecture seule, rien modifié)
```

Ne modifie rien : handshake + liste + stats uniquement. En cas d'échec,
le message indique s'il s'agit d'identifiants, de réseau ou de droits.

## Variables d'environnement

| Variable | Obligatoire | Défaut |
|---|---|---|
| `TC_EMAIL` | oui | — |
| `TC_PASSWORD` | oui | — |
| `TC_SUPABASE_URL` | non | backend embarqué de l'app |
| `TC_SUPABASE_ANON_KEY` | non | clé anon embarquée de l'app |

Le jeton de session ne vit qu'en mémoire du processus, jamais sur disque.

## Outils

| Outil | Rôle |
|---|---|
| `list_candidatures` | Liste (filtres `status`, `compartment`, `limit`) |
| `get_candidature` | Fiche complète par `id` |
| `add_candidature` | Crée (`company` requis ; relance auto si envoyée) |
| `update_candidature` | Modifie les champs (+ historique si statut changé) |
| `set_status` | Change le statut (date d'envoi, relance auto, historique) |
| `due_actions` | Relances dues (`within_days`, défaut 7) |
| `dashboard_stats` | Totaux, entretiens, offres, relances dues, répartitions |

## Serveur distant (multi-appareils)

Pour utiliser le MCP depuis **n'importe quel appareil** (comme les autres MCP distants),
déployez `remote.js` sur un hébergeur gratuit (Render, Railway, Fly.io, etc.) :

### 1. Variables d'environnement sur l'hébergeur

```
TC_EMAIL=votre@email.com
TC_PASSWORD=votre-mot-de-passe
PORT=3000 (ou le port imposé par l'hébergeur)
```

### 2. Commande de démarrage

```sh
node remote.js
```

### 3. Configurer dans OpenCode (sur n'importe quel appareil)

```sh
opencode mcp add trackcandidatures --url https://votre-serveur.com/mcp
```

Ou dans `~/.config/opencode/opencode.json` :
```jsonc
{
  "mcp": {
    "servers": {
      "trackcandidatures": {
        "type": "remote",
        "url": "https://votre-serveur.com/mcp"
      }
    }
  }
}
```

### Hébergeurs gratuits recommandés
- **Render** (render.com) : gratuit, déploiement depuis GitHub
- **Railway** (railway.app) : gratuit, déploiement depuis GitHub
- **Fly.io** (fly.io) : gratuit, déploiement via CLI

### Test local du serveur distant
```powershell
$env:TC_EMAIL = "vous@exemple.fr"
$env:TC_PASSWORD = "votre-mot-de-passe"
node remote.js
# Dans un autre terminal :
curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
