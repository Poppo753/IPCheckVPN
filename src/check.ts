import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StatusChecks {
  internet: boolean;
  ax1800_lan: boolean;
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

  // 3. IP pubblico (solo se internet è OK)
  const public_ip = internet ? await getPublicIP() : undefined;
  if (internet && !public_ip) notes.push("Impossibile ottenere l'IP pubblico");

  // 4. Tutto OK solo se entrambi i check passano
  const ok = internet && ax1800_lan;

  const status: Status = {
    ts: new Date().toISOString(),
    ok,
    checks: { internet, ax1800_lan, public_ip },
    notes: notes.length > 0 ? notes : undefined,
  };

  // Scrivi status.json nella cartella public/ (così GitHub Pages lo serve)
  const outDir = path.join(__dirname, "..", "public");
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
