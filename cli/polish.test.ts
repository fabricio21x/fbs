import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import type { PolishDeps } from "./polish";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbs-polish-"));
  dirs.push(dir);
  return dir;
}

const PONYTAIL_RUBRIC = "skills/ponytail-review/SKILL.md";
const THERMOS_RUBRIC = "skills/thermo-nuclear-code-quality-review/SKILL.md";

/** An install dir holding `rubric`, or none when null. */
function installDir(rubric: string | null): string {
  const dir = tempDir();
  if (rubric !== null) {
    mkdirSync(join(dir, rubric, ".."), { recursive: true });
    writeFileSync(join(dir, rubric), "# rubric\n");
  }
  return dir;
}

const entry = (id: string, installPath: string, enabled = true) => ({ id, version: "1.0.0", scope: "user", enabled, installPath });

interface Setup {
  plugins?: unknown[];
  listed?: { code?: number; stdout?: string; stderr?: string };
  env?: Record<string, string>;
  home?: string;
}

function check(setup: Setup) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: PolishDeps = {
    pluginList: () => ({ code: 0, stdout: JSON.stringify(setup.plugins ?? []), stderr: "", ...setup.listed }),
    env: setup.env ?? {},
    home: setup.home ?? tempDir(),
  };
  const code = run(["polish", "check"], { cwd: process.cwd(), today: "2026-11-03", out: (s) => out.push(s), err: (s) => err.push(s) }, undefined, undefined, deps);
  return { code, out, err };
}

/** A home whose ponytail config sets defaultMode off, so no warning shows. */
function quietHome(): string {
  const home = tempDir();
  mkdirSync(join(home, ".config", "ponytail"), { recursive: true });
  writeFileSync(join(home, ".config", "ponytail", "config.json"), '{"defaultMode":"off"}');
  return home;
}

const WARNING = "warning: ponytail's default mode is full; set it to off: type /ponytail default off in a session";

test("both rubrics present print their paths as one JSON line", () => {
  const ponytail = installDir(PONYTAIL_RUBRIC);
  const thermos = installDir(THERMOS_RUBRIC);
  const r = check({ plugins: [entry("fbs@fabs", tempDir()), entry("ponytail@ponytail", ponytail), entry("thermos@fabs", thermos)], home: quietHome() });
  expect(r).toEqual({ code: 0, out: [JSON.stringify({ ponytail: join(ponytail, PONYTAIL_RUBRIC), thermos: join(thermos, THERMOS_RUBRIC) })], err: [] });
});

test("any marketplace counts, and of several entries the enabled one with the rubric wins", () => {
  const thermos = installDir(THERMOS_RUBRIC);
  const ok = installDir(PONYTAIL_RUBRIC);
  const plugins = [entry("ponytail@other", installDir(null)), entry("ponytail@mine", installDir(PONYTAIL_RUBRIC), false), entry("ponytail@ok", ok), entry("thermos@cursor", thermos)];
  const r = check({ plugins, home: quietHome() });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out[0])).toEqual({ ponytail: join(ok, PONYTAIL_RUBRIC), thermos: join(thermos, THERMOS_RUBRIC) });
});

test("a missing ponytail names both install commands", () => {
  const r = check({ plugins: [entry("thermos@fabs", installDir(THERMOS_RUBRIC))] });
  expect(r).toEqual({
    code: 1,
    out: ["error: missing plugin: ponytail; run /plugin marketplace add DietrichGebert/ponytail, then /plugin install ponytail@ponytail", "then /reload-plugins"],
    err: [],
  });
});

test("a missing thermos installs from fbs's marketplace", () => {
  const r = check({ plugins: [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC))], home: quietHome() });
  expect(r).toEqual({ code: 1, out: ["error: missing plugin: thermos; run /plugin install thermos@fabs", "then /reload-plugins"], err: [] });
});

test("a disabled plugin is enabled by its id, and every problem gets a line", () => {
  const r = check({ plugins: [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC), false)], home: quietHome() });
  expect(r).toEqual({
    code: 1,
    out: ["error: disabled plugin: ponytail@ponytail; run /plugin enable ponytail@ponytail", "error: missing plugin: thermos; run /plugin install thermos@fabs", "then /reload-plugins"],
    err: [],
  });
});

test("an enabled plugin without its rubric file names the file", () => {
  const thermos = installDir(null);
  const r = check({ plugins: [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC)), entry("thermos@fabs", thermos)], home: quietHome() });
  expect(r).toEqual({ code: 1, out: [`error: missing rubric: ${join(thermos, THERMOS_RUBRIC)}; run /plugin update thermos@fabs, or reinstall it`, "then /reload-plugins"], err: [] });
});

test("output that isn't a JSON array is an error, never missing plugins", () => {
  for (const stdout of ["not json", '{"id":"ponytail@ponytail"}']) {
    expect(check({ listed: { stdout } })).toEqual({ code: 2, out: [], err: ["error: claude plugin list --json printed no JSON array"] });
  }
});

test("a rubric plugin listed without an installPath is an error, never missing plugins", () => {
  const r = check({ plugins: [{ id: "thermos@fabs", enabled: true }, entry("fbs@fabs", tempDir())] });
  expect(r).toEqual({ code: 2, out: [], err: ["error: claude plugin list --json gave thermos@fabs no installPath"] });
});

test("a claude that can't run or fails is an error with its reason", () => {
  expect(check({ listed: { code: 127, stderr: 'cannot run claude: Executable not found in $PATH: "claude"' } })).toEqual({
    code: 2,
    out: [],
    err: ['error: claude plugin list --json failed: cannot run claude: Executable not found in $PATH: "claude"'],
  });
  expect(check({ listed: { code: 1, stdout: "" } }).err).toEqual(["error: claude plugin list --json failed: exit 1"]);
});

test("ponytail's default mode warns on stderr: from the env, from the config file and from ponytail's default", () => {
  const plugins = [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC)), entry("thermos@fabs", installDir(THERMOS_RUBRIC))];

  const fromEnv = check({ plugins, env: { PONYTAIL_DEFAULT_MODE: " Lite " }, home: quietHome() });
  expect(fromEnv.code).toBe(0);
  expect(fromEnv.err).toEqual(["warning: ponytail's default mode is lite; set it to off: set PONYTAIL_DEFAULT_MODE=off where it is set"]);

  const xdg = tempDir();
  mkdirSync(join(xdg, "ponytail"));
  writeFileSync(join(xdg, "ponytail", "config.json"), '﻿{"defaultMode":"ULTRA"}');
  const fromConfig = check({ plugins, env: { PONYTAIL_DEFAULT_MODE: "review", XDG_CONFIG_HOME: xdg }, home: quietHome() });
  expect(fromConfig.err).toEqual([WARNING.replace("is full", "is ultra")]);

  const broken = tempDir();
  mkdirSync(join(broken, ".config", "ponytail"), { recursive: true });
  writeFileSync(join(broken, ".config", "ponytail", "config.json"), '{"defaultMode":');
  expect(check({ plugins, home: broken }).err).toEqual([WARNING]);
  expect(check({ plugins }).err).toEqual([WARNING]);
});

test("the mode warning also comes with missing plugins, and only when ponytail is enabled", () => {
  const missingThermos = check({ plugins: [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC))] });
  expect(missingThermos.code).toBe(1);
  expect(missingThermos.err).toEqual([WARNING]);

  expect(check({ plugins: [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC), false)] }).err).toEqual([]);

  expect(check({ plugins: [entry("thermos@fabs", installDir(THERMOS_RUBRIC))] }).err).toEqual([]);
});

test("an off mode doesn't warn, even when the env overrides a louder config", () => {
  const plugins = [entry("ponytail@ponytail", installDir(PONYTAIL_RUBRIC)), entry("thermos@fabs", installDir(THERMOS_RUBRIC))];
  const xdg = tempDir();
  mkdirSync(join(xdg, "ponytail"));
  writeFileSync(join(xdg, "ponytail", "config.json"), '{"defaultMode":"full"}');
  expect(check({ plugins, env: { PONYTAIL_DEFAULT_MODE: "OFF", XDG_CONFIG_HOME: xdg } }).err).toEqual([]);
  expect(check({ plugins, home: quietHome() }).err).toEqual([]);
});
