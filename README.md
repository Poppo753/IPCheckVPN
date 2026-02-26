# 🏠 Home Status Monitor

Controlla che la rete di casa (Vodafone → AX1800 VPN) sia attiva e pubblica lo stato su **GitHub Pages**.  
Apri la pagina da qualsiasi posto e vedi subito se è tutto OK o se c'è un problema.

## Come funziona

```
┌─────────────┐     ping/http      ┌──────────┐
│  PC di casa  │ ──────────────────→│ Internet  │
│  (check.ts)  │                    │  AX1800   │
│              │                    └──────────┘
│  status.json │───── git push ────→ GitHub Pages
└─────────────┘                      ↑
                                     │  apri dal telefono
                                     └── https://<user>.github.io/home-status/
```

- Ogni 5 minuti il PC esegue `check.ts`
- Controlla: internet (ping 1.1.1.1), AX1800 in LAN, IP pubblico
- Scrive `public/status.json` e fa push su GitHub
- La pagina `public/index.html` legge il JSON e mostra OK/KO

## Setup rapido

### 1. Installa dipendenze
```bash
npm install
```

### 2. Compila TypeScript
```bash
npm run build
```

### 3. Testa il check
```bash
npm run check
```
Vedrai un output tipo:
```
[2026-02-26T10:30:00.000Z] status.json → OK ✅
```

### 4. Configura Git + GitHub
```bash
git init
git remote add origin https://github.com/TUO-USER/home-status.git
git add .
git commit -m "init"
git push -u origin main
```

Poi vai su **GitHub → Settings → Pages** e imposta:
- Source: **Deploy from a branch**
- Branch: **main**, cartella: **/public**

### 5. Schedula l'esecuzione automatica
Apri **PowerShell come Amministratore** e:
```powershell
.\setup-scheduler.ps1
```
Questo crea un'operazione pianificata che ogni 5 minuti:
1. Esegue il check di rete
2. Committa e pusha `status.json`

### 6. Fatto!
Apri `https://<tuo-user>.github.io/home-status/` e vedi lo stato in tempo reale.

## Configurazione

| Variabile d'ambiente | Default        | Descrizione                    |
|----------------------|----------------|--------------------------------|
| `AX1800_IP`          | `192.168.1.10` | IP del router AX1800 in LAN   |

Per cambiarla, prima di eseguire il check:
```powershell
$env:AX1800_IP = "192.168.1.100"
```
Oppure impostala nelle variabili d'ambiente di sistema di Windows.

## Credenziali GitHub per push automatico

Il push automatico richiede che git possa autenticarsi. Le opzioni:

1. **Git Credential Manager** (consigliato su Windows): si configura automaticamente con `git clone` via HTTPS
2. **GitHub PAT (token)**: crea un token su GitHub → Settings → Developer Settings → Personal Access Tokens, poi:
   ```bash
   git remote set-url origin https://<TOKEN>@github.com/TUO-USER/home-status.git
   ```

> ⚠ Non committare mai il token nel repo!
