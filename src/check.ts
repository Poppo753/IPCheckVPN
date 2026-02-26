import fs from "fs";
import net from "net";
import path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StatusChecks {
  internet: boolean;
  ax1800_lan: boolean;
  vpn_tunnel: boolean;
  public_ip?: string;
}

interface Status {
  ts: string;
  ok: boolean;
  checks: StatusChecks;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ping a host (Windows-compatible). Returns true if reachable. */
function ping(host: string): boolean {
  try {
    // -n 1 = one packet, -w 2000 = 2 s timeout
    execSync(`ping -n 1 -w 2000 ${host}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a TCP port is open on a host (connect + immediate close).
 * Works for OpenVPN (TCP mode) and most VPN admin panels.
 * For WireGuard (UDP), we rely on ping to the VPN interface instead.
 */
function checkPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error",   () => { sock.destroy(); resolve(false); });
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
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const notes: string[] = [];

  // 1. Internet — ping Cloudflare DNS
  const internet = ping("1.1.1.1");
  if (!internet) notes.push("No ping to 1.1.1.1 — internet down?");

  // 2. AX1800 raggiungibile in LAN
  const ax1800IP = process.env.AX1800_IP || "192.168.1.10";
  const ax1800_lan = ping(ax1800IP);
  if (!ax1800_lan) notes.push(`AX1800 non raggiungibile a ${ax1800IP}`);

  // 3. VPN tunnel — controlla porta VPN sull'AX1800 (default WireGuard 51820 TCP fallback,
  //    oppure OpenVPN 1194). Se il router espone una porta TCP per la VPN, questo la rileva.
  //    In alternativa pinga l'interfaccia VPN (es. 10.0.0.1) se configurata.
  const vpnPort = Number(process.env.VPN_PORT) || 51820;
  const vpnInterfaceIP = process.env.VPN_INTERFACE_IP; // es. "10.0.0.1"
  let vpn_tunnel = false;
  if (ax1800_lan) {
    // Prova prima la porta TCP
    vpn_tunnel = await checkPort(ax1800IP, vpnPort);
    // Se non risponde su TCP, prova ping all'interfaccia VPN (se configurata)
    if (!vpn_tunnel && vpnInterfaceIP) {
      vpn_tunnel = ping(vpnInterfaceIP);
    }
    // Fallback: se la porta non è TCP (es. WireGuard è solo UDP), consideriamo
    // il servizio attivo se l'AX1800 risponde al ping E internet funziona
    if (!vpn_tunnel && !vpnInterfaceIP) {
      notes.push(`Porta VPN ${vpnPort}/tcp non risponde su ${ax1800IP} (normale se WireGuard UDP)`);
      // Se hai un IP interfaccia VPN, impostalo con VPN_INTERFACE_IP per un check preciso
    }
  }
  if (!vpn_tunnel && ax1800_lan) notes.push("Tunnel VPN non verificato — imposta VPN_INTERFACE_IP per check preciso");

  // 4. IP pubblico (solo se internet è OK)
  const public_ip = internet ? await getPublicIP() : undefined;
  if (internet && !public_ip) notes.push("Impossibile ottenere l'IP pubblico");

  // 5. Tutto OK solo se tutti i check critici passano
  const ok = internet && ax1800_lan && vpn_tunnel;

  const status: Status = {
    ts: new Date().toISOString(),
    ok,
    checks: { internet, ax1800_lan, vpn_tunnel, public_ip },
    notes: notes.length > 0 ? notes : undefined,
  };

  // Scrivi status.json nella cartella docs/ (così GitHub Pages lo serve)
  const outDir = path.join(__dirname, "..", "docs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "status.json");

  fs.writeFileSync(outPath, JSON.stringify(status, null, 2), "utf-8");
  console.log(`[${status.ts}] status.json → ${status.ok ? "OK ✅" : "KO ❌"}`);
  if (notes.length) console.log("  Note:", notes.join("; "));
}

main().catch((err) => {
  console.error("check failed:", err);
  process.exit(1);
});
