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
  gateway: {
    ip: string;
    is_vpn_router: boolean;
  };
  network_interface?: {
    name: string;              // es. "Ethernet", "Wi-Fi"
    type: string;              // "Ethernet" | "WiFi" | "Other"
    speed_mbps?: number;
  };
  public_ip?: string;
  ip_changed?: boolean;
}

interface StatusMeta {
  uptime_pct: number;           // % check OK nello storico
  last_down?: string;           // ISO timestamp dell'ultimo KO
  total_checks: number;
}

interface Status {
  ts: string;
  ok: boolean;
  checks: StatusChecks;
  meta: StatusMeta;
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

/** Leggi il default gateway da Windows (route print / ipconfig). */
function getDefaultGateway(): string | undefined {
  try {
    const raw = execSync(
      'powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop"',
      { encoding: "utf-8", timeout: 5000 }
    );
    const ip = raw.trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}

/** Rileva l'interfaccia di rete attiva (WiFi / Ethernet + velocità). */
function getNetworkInterface(): StatusChecks["network_interface"] | undefined {
  try {
    const raw = execSync(
      'powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq Up | Select-Object -First 1 Name,InterfaceDescription,LinkSpeed | ConvertTo-Json"',
      { encoding: "utf-8", timeout: 5000 }
    );
    const info = JSON.parse(raw.trim()) as { Name?: string; InterfaceDescription?: string; LinkSpeed?: string };
    if (!info.Name) return undefined;

    const name = info.Name;
    const isWifi = /wi-?fi|wireless|wlan/i.test(name + " " + (info.InterfaceDescription || ""));
    const type = isWifi ? "WiFi" : /ethernet/i.test(name) ? "Ethernet" : "Other";

    let speed_mbps: number | undefined;
    if (info.LinkSpeed) {
      const m = info.LinkSpeed.match(/([\d.]+)\s*(Gbps|Mbps)/i);
      if (m) {
        speed_mbps = parseFloat(m[1]) * (/gbps/i.test(m[2]) ? 1000 : 1);
      }
    }

    return { name, type, speed_mbps };
  } catch {
    return undefined;
  }
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

  // 5. Default gateway — stai uscendo dall'AX1800 o dalla Vodafone Station?
  const gatewayIP = getDefaultGateway();
  const vodafoneGW = process.env.VODAFONE_GW || "192.168.1.1";
  const is_vpn_router = !!(gatewayIP && gatewayIP === ax1800IP);
  const gateway = {
    ip: gatewayIP || "sconosciuto",
    is_vpn_router,
  };
  if (!gatewayIP) {
    notes.push("Impossibile rilevare il default gateway");
  } else if (gatewayIP === vodafoneGW) {
    notes.push(`Gateway = ${gatewayIP} (Vodafone Station) — NON stai passando dalla VPN!`);
  } else if (gatewayIP === ax1800IP) {
    // perfetto, traffico via AX1800
  } else {
    notes.push(`Gateway = ${gatewayIP} — non è né Vodafone né AX1800, controlla la rete`);
  }

  // 6. IP pubblico + change detection
  const public_ip = internet.up ? await getPublicIP() : undefined;
  if (internet.up && !public_ip) notes.push("Impossibile ottenere l'IP pubblico");

  const previousIP = getPreviousIP(history);
  const ip_changed = !!(public_ip && previousIP && public_ip !== previousIP);
  if (ip_changed) notes.push(`IP pubblico cambiato: ${previousIP} → ${public_ip}`);

  // 7. Interfaccia di rete attiva
  const network_interface = getNetworkInterface();

  // 8. Risultato finale
  const ok = internet.up && ax1800_lan.up && is_vpn_router;

  // 9. Meta: uptime % e ultimo down
  const allEntries = [{ ok, ts: new Date().toISOString() }, ...history.entries];
  const okCount = allEntries.filter(e => e.ok).length;
  const uptime_pct = Math.round((okCount / allEntries.length) * 1000) / 10; // 1 decimale
  const lastDown = history.entries.find(e => !e.ok);
  const meta: StatusMeta = {
    uptime_pct,
    last_down: lastDown?.ts,
    total_checks: allEntries.length,
  };

  const status: Status = {
    ts: new Date().toISOString(),
    ok,
    checks: {
      internet,
      dns: dnsCheck,
      ax1800_lan,
      vpn_tunnel,
      gateway,
      network_interface,
      public_ip,
      ip_changed,
    },
    meta,
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
  console.log(`  Gateway:  ${gateway.ip} ${is_vpn_router ? '(AX1800 ✅)' : '(⚠ NON VPN)'}`);
  if (network_interface) console.log(`  Rete:     ${network_interface.name} (${network_interface.type}${network_interface.speed_mbps ? ', ' + network_interface.speed_mbps + ' Mbps' : ''})`);
  console.log(`  Uptime:   ${meta.uptime_pct}% (${meta.total_checks} check)`);
  if (ip_changed) console.log(`  ⚠ IP cambiato: ${previousIP} → ${public_ip}`);
  if (notes.length) console.log("  Note:", notes.join("; "));
}

main().catch((err) => {
  console.error("check failed:", err);
  process.exit(1);
});
