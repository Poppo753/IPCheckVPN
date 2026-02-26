import fs from "fs";
import dns from "dns/promises";
import net from "net";
import path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CheckResult {
  up: boolean;
  latency_ms?: number;        // tempo di risposta in ms
}

interface StatusChecks {
  internet: CheckResult;
  dns: CheckResult;
  ax1800_lan: CheckResult;
  vpn_tunnel: CheckResult;
  public_ip?: string;
  ip_changed?: boolean;        // true se l'IP è diverso dal check precedente
}

interface Status {
  ts: string;
  ok: boolean;
  checks: StatusChecks;
  notes?: string[];
}

/** Storico delle ultime N rilevazioni */
interface HistoryFile {
  entries: Status[];
}

const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ping a host and return up + latency in ms (Windows). */
function ping(host: string): CheckResult {
  try {
    const start = performance.now();
    execSync(`ping -n 1 -w 2000 ${host}`, { stdio: "ignore" });
    const latency_ms = Math.round(performance.now() - start);
    return { up: true, latency_ms };
  } catch {
    return { up: false };
  }
}

/** DNS resolution check — resolve google.com and measure time. */
async function checkDNS(): Promise<CheckResult> {
  try {
    const start = performance.now();
    await dns.resolve4("google.com");
    const latency_ms = Math.round(performance.now() - start);
    return { up: true, latency_ms };
  } catch {
    return { up: false };
  }
}

/**
 * Check if a TCP port is open on a host (connect + immediate close).
 * Returns up + latency.
 */
function checkPort(host: string, port: number, timeoutMs = 3000): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      const latency_ms = Math.round(performance.now() - start);
      sock.destroy();
      resolve({ up: true, latency_ms });
    });
    sock.once("timeout", () => { sock.destroy(); resolve({ up: false }); });
    sock.once("error",   () => { sock.destroy(); resolve({ up: false }); });
    sock.connect(port, host);
  });
}

/** Fetch public IP via ipify (returns undefined on failure). */
async function getPublicIP(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: controller.signal,
    } as RequestInit);
    clearTimeout(timer);
    const json = (await res.json()) as { ip?: string };
    return json.ip;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------
function loadHistory(filePath: string): HistoryFile {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as HistoryFile;
  } catch {
    return { entries: [] };
  }
}

function saveHistory(filePath: string, history: HistoryFile): void {
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), "utf-8");
}

function getPreviousIP(history: HistoryFile): string | undefined {
  for (const entry of history.entries) {
    if (entry.checks.public_ip) return entry.checks.public_ip;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const notes: string[] = [];
  const outDir = path.join(__dirname, "..", "docs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const historyPath = path.join(outDir, "history.json");
  const history = loadHistory(historyPath);

  // 1. Internet — ping Cloudflare DNS
  const internet = ping("1.1.1.1");
  if (!internet.up) notes.push("No ping a 1.1.1.1 — internet down?");

  // 2. DNS — risolvi google.com
  const dnsCheck = internet.up ? await checkDNS() : { up: false } as CheckResult;
  if (internet.up && !dnsCheck.up) notes.push("DNS non risponde — risoluzione nomi KO");

  // 3. AX1800 raggiungibile in LAN
  const ax1800IP = process.env.AX1800_IP || "192.168.1.10";
  const ax1800_lan = ping(ax1800IP);
  if (!ax1800_lan.up) notes.push(`AX1800 non raggiungibile a ${ax1800IP}`);

  // 4. VPN tunnel
  const vpnPort = Number(process.env.VPN_PORT) || 51820;
  const vpnInterfaceIP = process.env.VPN_INTERFACE_IP; // es. "10.0.0.1"
  let vpn_tunnel: CheckResult = { up: false };
  if (ax1800_lan.up) {
    vpn_tunnel = await checkPort(ax1800IP, vpnPort);
    if (!vpn_tunnel.up && vpnInterfaceIP) {
      vpn_tunnel = ping(vpnInterfaceIP);
    }
    if (!vpn_tunnel.up && !vpnInterfaceIP) {
      notes.push(`Porta VPN ${vpnPort}/tcp non risponde (normale se WireGuard UDP)`);
    }
  }
  if (!vpn_tunnel.up && ax1800_lan.up) {
    notes.push("Tunnel VPN non verificato — imposta VPN_INTERFACE_IP per check preciso");
  }

  // 5. IP pubblico + change detection
  const public_ip = internet.up ? await getPublicIP() : undefined;
  if (internet.up && !public_ip) notes.push("Impossibile ottenere l'IP pubblico");

  const previousIP = getPreviousIP(history);
  const ip_changed = !!(public_ip && previousIP && public_ip !== previousIP);
  if (ip_changed) notes.push(`IP pubblico cambiato: ${previousIP} → ${public_ip}`);

  // 6. Risultato finale
  const ok = internet.up && ax1800_lan.up && vpn_tunnel.up;

  const status: Status = {
    ts: new Date().toISOString(),
    ok,
    checks: {
      internet,
      dns: dnsCheck,
      ax1800_lan,
      vpn_tunnel,
      public_ip,
      ip_changed,
    },
    notes: notes.length > 0 ? notes : undefined,
  };

  // Scrivi status.json
  const statusPath = path.join(outDir, "status.json");
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");

  // Aggiorna storico (max 20 entries, più recente in cima)
  history.entries.unshift(status);
  if (history.entries.length > MAX_HISTORY) {
    history.entries = history.entries.slice(0, MAX_HISTORY);
  }
  saveHistory(historyPath, history);

  console.log(`[${status.ts}] status.json → ${ok ? "OK ✅" : "KO ❌"}`);
  if (internet.latency_ms) console.log(`  Internet: ${internet.latency_ms}ms`);
  if (ax1800_lan.latency_ms) console.log(`  AX1800:   ${ax1800_lan.latency_ms}ms`);
  if (ip_changed) console.log(`  ⚠ IP cambiato: ${previousIP} → ${public_ip}`);
  if (notes.length) console.log("  Note:", notes.join("; "));
}

main().catch((err) => {
  console.error("check failed:", err);
  process.exit(1);
});
