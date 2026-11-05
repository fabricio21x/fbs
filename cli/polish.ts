import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What `fbs polish check` reads outside the repo; tests pass fakes. */
export interface PolishDeps {
  /** Runs `claude plugin list --json`. */
  pluginList: () => ClaudeResult;
  env: Record<string, string | undefined>;
  home: string;
}

let claudeBinary = "claude";

/** `bin/fbs` passes claude's path, because the eval sandbox hides PATH from the compiled CLI. */
export function setClaudeBinary(path: string): void {
  claudeBinary = path;
}

const CLAUDE_TIMEOUT_MS = 60_000;

function runPluginList(): ClaudeResult {
  try {
    const result = Bun.spawnSync([claudeBinary, "plugin", "list", "--json"], { stdout: "pipe", stderr: "pipe", timeout: CLAUDE_TIMEOUT_MS });
    const stderr = result.exitedDueToTimeout ? `timed out after ${CLAUDE_TIMEOUT_MS / 1000}s` : (result.stderr?.toString() ?? "");
    return { code: result.exitCode ?? 1, stdout: result.stdout?.toString() ?? "", stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `cannot run claude: ${(e as Error).message}` };
  }
}

export const REAL_POLISH_DEPS: PolishDeps = { pluginList: runPluginList, env: process.env, home: homedir() };

const RUBRICS = {
  ponytail: { skill: "ponytail-review", install: "/plugin marketplace add DietrichGebert/ponytail, then /plugin install ponytail@ponytail" },
  thermos: { skill: "thermo-nuclear-code-quality-review", install: "/plugin install thermos@fabs" },
};

interface Plugin {
  id: string;
  enabled: boolean;
  installPath: string;
}

/** `fbs polish check`: exit 0 printing both rubric paths, 1 with a line and fix per problem, 2 when claude can't list plugins. */
export function checkPolish(deps: PolishDeps, out: (s: string) => void, err: (s: string) => void): number {
  const listed = deps.pluginList();
  if (listed.code !== 0) {
    err(`error: claude plugin list --json failed: ${listed.stderr.trim().split("\n")[0] || `exit ${listed.code}`}`);
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(listed.stdout);
  } catch {}
  if (!Array.isArray(raw)) {
    err("error: claude plugin list --json printed no JSON array");
    return 2;
  }
  const plugins = raw.filter((p): p is Plugin => typeof p?.id === "string" && p.id.split("@")[0] in RUBRICS);
  const shapeless = plugins.find((p) => typeof p.installPath !== "string");
  if (shapeless !== undefined) {
    err(`error: claude plugin list --json gave ${shapeless.id} no installPath`);
    return 2;
  }

  const paths: Record<string, string> = {};
  const problems: string[] = [];
  for (const [name, { skill, install }] of Object.entries(RUBRICS)) {
    const installs = plugins.filter((p) => p.id.split("@")[0] === name);
    const enabled = installs.filter((p) => p.enabled === true);
    const rubric = (p: Plugin) => join(p.installPath, "skills", skill, "SKILL.md");
    const found = enabled.map(rubric).find((path) => existsSync(path));
    if (found !== undefined) paths[name] = found;
    else if (enabled.length > 0) problems.push(`error: missing rubric: ${rubric(enabled[0])}; run /plugin update ${enabled[0].id}, or reinstall it`);
    else if (installs.length > 0) problems.push(`error: disabled plugin: ${installs[0].id}; run /plugin enable ${installs[0].id}`);
    else problems.push(`error: missing plugin: ${name}; run ${install}`);
  }

  if (plugins.some((p) => p.id.split("@")[0] === "ponytail" && p.enabled === true)) {
    const warning = modeWarning(deps);
    if (warning !== null) err(warning);
  }
  if (problems.length > 0) {
    for (const line of [...problems, "then /reload-plugins"]) out(line);
    return 1;
  }
  out(JSON.stringify(paths));
  return 0;
}

/** An enabled ponytail starts each session, and so its agents, in its default mode; resolved the way ponytail does. */
function modeWarning(deps: PolishDeps): string | null {
  const runtimeMode = (mode: unknown) => (typeof mode === "string" && ["off", "lite", "full", "ultra"].includes(mode.trim().toLowerCase()) ? mode.trim().toLowerCase() : null);
  const warn = (mode: string, fix: string) => (mode === "off" ? null : `warning: ponytail's default mode is ${mode}; set it to off: ${fix}`);
  const fromEnv = runtimeMode(deps.env.PONYTAIL_DEFAULT_MODE);
  if (fromEnv !== null) return warn(fromEnv, "set PONYTAIL_DEFAULT_MODE=off where it is set");

  let fromConfig: string | null = null;
  try {
    const config = JSON.parse(readFileSync(join(deps.env.XDG_CONFIG_HOME || join(deps.home, ".config"), "ponytail", "config.json"), "utf8").replace(/^\uFEFF/, ""));
    fromConfig = runtimeMode(config?.defaultMode);
  } catch {}
  return warn(fromConfig ?? "full", "type /ponytail default off in a session");
}
