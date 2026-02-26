import { execSync } from "child_process";
import path from "path";

/**
 * Commit & push public/status.json to the current branch.
 *
 * Requires git to be configured (remote, credentials).
 * On Windows, store your GitHub PAT via:
 *   git credential-manager store
 * or set the env var GITHUB_TOKEN and use the https URL with token.
 */
function main(): void {
  const root = path.join(__dirname, "..");
  const run = (cmd: string) =>
    execSync(cmd, { cwd: root, stdio: "inherit" });

  try {
    run("git add docs/status.json docs/history.json");
    run('git diff --cached --quiet || git commit -m "status update"');
    run("git push");
    console.log("Push completato ✅");
  } catch (err) {
    console.error("Push fallito:", err);
    process.exit(1);
  }
}

main();
