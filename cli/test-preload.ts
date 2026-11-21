import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Run inside Claude Code, the suite would otherwise bind camps and land requests to the session running it.
delete process.env.CLAUDE_CODE_SESSION_ID;

// An empty config home, so the developer's own fbs and git user files never reach a test.
const configHome = mkdtempSync(join(tmpdir(), "fbs-xdg-"));
process.env.XDG_CONFIG_HOME = configHome;
process.on("exit", () => rmSync(configHome, { recursive: true, force: true }));
