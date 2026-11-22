import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig, projectConfig, type Tracker } from "./config";
import { run } from "./main";
import { isolatedGitEnv } from "./test-env";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function repoWithConfig(content?: string): string {
  dir = mkdtempSync(join(tmpdir(), "fbs-config-"));
  if (content !== undefined) {
    mkdirSync(join(dir, ".fbs"));
    writeFileSync(join(dir, ".fbs", "config.json"), content);
  }
  return dir;
}

test("no .fbs dir gives the defaults", () => {
  expect(loadConfig(repoWithConfig())).toEqual(DEFAULT_CONFIG);
});

test("a partial config keeps the other defaults", () => {
  const config = loadConfig(repoWithConfig('{"context":{"maxFacts":10}}'));
  expect(config).toEqual({ featuresDir: "docs/features", context: { maxFacts: 10, staleDays: 30 } });
});

test("invalid JSON throws a ConfigError naming the file", () => {
  const root = repoWithConfig("{not json");
  expect(() => loadConfig(root)).toThrow(ConfigError);
  expect(() => loadConfig(root)).toThrow(".fbs/config.json");
});

test.each(["/abs/features", "../features", "docs/../features", "docs/..", ".git", ".git/features", ".GIT/features", "./.git/features", "docs/.git/features", "docs/.Git", "docs/.git/"])(
  "featuresDir %p is a ConfigError",
  (featuresDir) => {
    expect(() => loadConfig(repoWithConfig(JSON.stringify({ featuresDir })))).toThrow(ConfigError);
  },
);

test.each(["specs/features", ".github/features", "docs/.gitkeep", "docs/x.git"])("featuresDir %p is kept", (featuresDir) => {
  expect(loadConfig(repoWithConfig(JSON.stringify({ featuresDir }))).featuresDir).toBe(featuresDir);
});

test.each(['{"afk":[]}', '{"afk":{"migrations":"sql/**"}}', '{"afk":{"infra":[1]}}', '{"afk":{"deny":null}}'])("afk config %s is a ConfigError", (content) => {
  expect(() => loadConfig(repoWithConfig(content))).toThrow(ConfigError);
});

test.each<[Tracker]>([[{ kind: "linear", team: "ACM" }], [{ kind: "github" }], [{ kind: "none" }]])("tracker %j is kept", (tracker) => {
  expect(loadConfig(repoWithConfig(JSON.stringify({ tracker }))).tracker).toEqual(tracker);
});

test("no tracker key leaves it unset", () => {
  expect(loadConfig(repoWithConfig("{}")).tracker).toBeUndefined();
});

test.each([
  '{"tracker":"none"}',
  '{"tracker":{"kind":"jira"}}',
  '{"tracker":{"kind":"linear"}}',
  '{"tracker":{"kind":"linear","team":" "}}',
  '{"tracker":{"kind":"linear","team":7}}',
  '{"tracker":{"kind":"github","team":"ACM"}}',
  '{"tracker":{"kind":"none","extra":true}}',
  '{"tracker":null}',
])("tracker config %s is a ConfigError", (content) => {
  expect(() => loadConfig(repoWithConfig(content))).toThrow(ConfigError);
});

test("branches.types is kept, and no branches key leaves it unset", () => {
  expect(loadConfig(repoWithConfig('{"branches":{"types":["feat","fix","chore"]}}')).branches).toEqual({ types: ["feat", "fix", "chore"] });
  expect(loadConfig(repoWithConfig("{}")).branches).toBeUndefined();
});

test.each([
  '{"branches":[]}',
  '{"branches":{"types":"feat"}}',
  '{"branches":{"types":[]}}',
  '{"branches":{"types":[1]}}',
  '{"branches":{"types":["Feat"]}}',
  '{"branches":{"types":["feat","release"]}}',
  '{"branches":{"types":["feat","fix","feat"]}}',
])("branches config %s is a ConfigError", (content) => {
  expect(() => loadConfig(repoWithConfig(content))).toThrow("branches");
});

test("camp.autoFixRounds is kept", () => {
  expect(loadConfig(repoWithConfig('{"camp":{"autoFixRounds":3}}')).camp).toEqual({ autoFixRounds: 3 });
});

test.each(['{"camp":[]}', '{"camp":{"autoFixRounds":0}}', '{"camp":{"autoFixRounds":-1}}', '{"camp":{"autoFixRounds":1.5}}', '{"camp":{"autoFixRounds":"2"}}'])(
  "camp config %s is a ConfigError",
  (content) => {
    expect(() => loadConfig(repoWithConfig(content))).toThrow("camp");
  },
);

test("verify.suite and verify.ciEvidence are kept, and ciEvidence defaults to off", () => {
  expect(loadConfig(repoWithConfig('{"verify":{"suite":"pnpm test --filter api","ciEvidence":true,"ciWorkflows":["CI"]}}')).verify).toEqual({ suite: "pnpm test --filter api", ciEvidence: true, ciWorkflows: ["CI"] });
  expect(loadConfig(repoWithConfig('{"verify":{"suite":"bun test --max-concurrency 2"}}')).verify).toEqual({ suite: "bun test --max-concurrency 2", ciEvidence: false });
  expect(loadConfig(repoWithConfig("{}")).verify).toBeUndefined();
});

test.each([
  '{"verify":[]}',
  '{"verify":{"suite":""}}',
  '{"verify":{"suite":"  "}}',
  '{"verify":{"suite":3}}',
  '{"verify":{"ciEvidence":"true"}}',
  '{"verify":{"ciEvidence":1}}',
  '{"verify":{"ciEvidence":true}}',
  '{"verify":{"ciEvidence":true,"ciWorkflows":[]}}',
  '{"verify":{"ciEvidence":true,"ciWorkflows":"CI"}}',
  '{"verify":{"ciEvidence":true,"ciWorkflows":["CI"," "]}}',
  '{"verify":{"ciEvidence":true,"ciWorkflows":["CI","CI"]}}',
])(
  "verify config %s is a ConfigError",
  (content) => {
    expect(() => loadConfig(repoWithConfig(content))).toThrow("verify");
  },
);

test.each([
  '{"docs":{"store":"local"}}',
  '{"docs":{"store":"tracked","publish":{"kind":"none"}}}',
  '{"docs":{"publish":{"kind":"notion","parent":"https://www.notion.so/acme/Specs-1a2b"}}}',
  '{"docs":{"publish":{"kind":"google-docs","parent":"folder-1"}}}',
])("docs config %s is kept", (content) => {
  expect(loadConfig(repoWithConfig(content)).docs).toEqual(JSON.parse(content).docs);
});

test.each([
  '{"docs":[]}',
  '{"docs":{"store":"shared"}}',
  '{"docs":{"publish":"notion"}}',
  '{"docs":{"publish":{"kind":"notion"}}}',
  '{"docs":{"publish":{"kind":"notion","parent":" "}}}',
  '{"docs":{"publish":{"kind":"none","parent":"x"}}}',
  '{"docs":{"publish":{"kind":"Not Ion","parent":"x"}}}',
  '{"docs":{"publish":{"kind":"notion","parent":"x","extra":1}}}',
])("docs config %s is a ConfigError", (content) => {
  expect(() => loadConfig(repoWithConfig(content))).toThrow("docs");
});

describe("two levels: the repo's .fbs/config.json and the user's", () => {
  const before = process.env.XDG_CONFIG_HOME;
  let xdg: string;
  const temps: string[] = [];

  function temp(): string {
    const made = realpathSync(mkdtempSync(join(tmpdir(), "fbs-levels-")));
    temps.push(made);
    return made;
  }

  beforeEach(() => {
    xdg = temp();
    process.env.XDG_CONFIG_HOME = xdg;
  });

  afterEach(() => {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
    for (const made of temps.splice(0)) rmSync(made, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): void {
    const result = Bun.spawnSync(["git", "-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }

  function repo(origin?: string, files: Record<string, string> = {}): string {
    const root = temp();
    git(root, "init", "-q");
    if (origin !== undefined) git(root, "remote", "add", "origin", origin);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  function userFile(content: unknown): string {
    const path = join(xdg, "fbs", "config.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  }

  function fbs(cwd: string, ...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(args, { cwd, today: "2026-10-21", out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out, err, json: () => JSON.parse(out[0]) };
  }

  const USER = {
    defaults: { tracker: { kind: "none" }, context: { staleDays: 10 }, docs: { store: "local" }, branches: { types: ["feat", "fix"] } },
    owners: {
      "acme-co": { tracker: { kind: "linear", team: "ACM" }, camp: { autoFixRounds: 3 }, docs: { publish: { kind: "notion", parent: "https://www.notion.so/acme/Specs-1a2b" } } },
      other: { tracker: { kind: "github" } },
    },
  };

  test("config show resolves the repo, then origin's owner block, then the user's defaults, then the built-in, key by key, naming each key's source", () => {
    userFile(USER);
    const r = fbs(repo("git@github.com:acme-co/app.git", { ".fbs/config.json": '{"verify":{"suite":"pnpm test"},"docs":{"store":"tracked"}}' }), "config", "show");
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.json()).toEqual({
      featuresDir: "docs/features",
      context: { maxFacts: 25, staleDays: 10 },
      tracker: { kind: "linear", team: "ACM" },
      camp: { autoFixRounds: 3 },
      branches: { types: ["feat", "fix"] },
      verify: { suite: "pnpm test", ciEvidence: false },
      docs: { store: "tracked", publish: { kind: "notion", parent: "https://www.notion.so/acme/Specs-1a2b" } },
      sources: { featuresDir: "default", context: "user+default", tracker: "owner:acme-co", camp: "owner:acme-co", branches: "user", verify: "repo", docs: "repo+owner:acme-co" },
    });
  });

  test.each([
    "https://github.com/acme-co/app.git",
    "ssh://git@github.com/acme-co/app",
    "ssh://git@github.com:2222/acme-co/app.git",
    "https://github.com:8443/acme-co/app",
    "git@github.com:acme-co/app",
    "git@github.com:/acme-co/app.git",
    "git@git.example.com:acme-co/app.git",
  ])("origin %s is owner acme-co, on any host", (origin) => {
    userFile(USER);
    expect(fbs(repo(origin), "config", "show").json().tracker).toEqual({ kind: "linear", team: "ACM" });
  });

  test("the owner block matches without case, and sources name it as the file writes it", () => {
    userFile(USER);
    expect(fbs(repo("https://alex@github.com/Acme-Co/app/"), "config", "show").json()).toMatchObject({ tracker: { kind: "linear", team: "ACM" }, sources: { tracker: "owner:acme-co" } });
  });

  test("without origin, or with a local path or file URL, only the user's defaults apply", () => {
    userFile({ ...USER, owners: { ...USER.owners, srv: { tracker: { kind: "github" } } } });
    expect(fbs(repo(), "config", "show").json().sources.tracker).toBe("user");
    expect(fbs(repo("/srv/git/app.git"), "config", "show").json().sources.tracker).toBe("user");
    expect(fbs(repo("file://host/srv/git/app.git"), "config", "show").json().sources.tracker).toBe("user");
    expect(fbs(repo("file:///srv/git/app.git"), "config", "show").json().sources.tracker).toBe("user");
  });

  test.each<[unknown, string]>([
    [{ defaults: { featuresDir: "specs" } }, "(defaults): featuresDir is repo-only"],
    [{ defaults: { verify: { suite: "bun test" } } }, "(defaults): verify is repo-only"],
    [{ owners: { "acme-co": { afk: { deny: ["deploy"] } } } }, "(owners.acme-co): afk is repo-only"],
    [{ owners: { other: { verify: { ciEvidence: false } } } }, "(owners.other): verify is repo-only"],
    [{ default: { tracker: { kind: "none" } } }, "unknown key default"],
    [{ defaults: { trackr: { kind: "none" } } }, "(defaults): unknown key trackr"],
    [{ owners: { "acme-co": { docs: { publsh: { kind: "none" } } } } }, "(owners.acme-co): unknown key docs.publsh"],
  ])("the user file %j is refused, naming the file and block", (content, reason) => {
    const path = userFile(content);
    const r = fbs(repo("git@github.com:acme-co/app.git"), "config", "show");
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain(path);
    expect(r.err.join("\n")).toContain(reason);
  });

  test.each([["verify.suite", '"bun test"'], ["afk.deny", '["deploy"]'], ["featuresDir", '"specs"']])("config set %s at the owner or user level is refused as repo-only", (key, value) => {
    const cwd = repo("git@github.com:acme-co/app.git");
    for (const level of ["--owner", "--user"]) {
      const r = fbs(cwd, "config", "set", key, value, level);
      expect(r.code).toBe(2);
      expect(r.err.join("\n")).toContain(`${key.split(".")[0]} is repo-only`);
    }
    expect(existsSync(join(xdg, "fbs", "config.json"))).toBe(false);
    expect(fbs(cwd, "config", "set", key, value).code).toBe(0);
  });

  test("from a linked worktree, docs.store local excludes the features folder in the shared info/exclude", () => {
    const main = repo();
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const linked = join(temp(), "linked");
    git(main, "worktree", "add", "-q", linked);
    expect(fbs(linked, "config", "set", "docs.store", '"local"', "--user").json().excluded).toBe("/docs/features/");
    expect(readFileSync(join(main, ".git", "info", "exclude"), "utf8")).toContain("/docs/features/\n");
    expect(fbs(linked, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(fbs(linked, "status", "show", "paid-plans").json()).toMatchObject({ docs: "local", docsRoot: join(main, "docs/features/2026-10-21-paid-plans") });
  });

  test("a missing or unreadable user file is none, never an error", () => {
    const cwd = repo("git@github.com:acme-co/app.git");
    expect(fbs(cwd, "config", "show").json()).toEqual({ ...DEFAULT_CONFIG, sources: { featuresDir: "default", context: "default" } });
    chmodSync(userFile(USER), 0o000);
    expect(fbs(cwd, "config", "show").json().tracker).toBeUndefined();
    expect(projectConfig(cwd)).toEqual(DEFAULT_CONFIG);
  });

  test("an invalid user file is an environment error naming it", () => {
    const path = userFile("{nope");
    const r = fbs(repo(), "config", "show");
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain(path);
    userFile({ defaults: { tracker: { kind: "jira" } } });
    expect(fbs(repo(), "config", "show").err.join("\n")).toContain("(defaults)");
  });

  test("the user's keys reach every consumer: the tracker", () => {
    userFile(USER);
    expect(fbs(repo("git@github.com:acme-co/app.git"), "tracker", "show").out).toEqual(['{"kind":"linear","team":"ACM"}']);
  });

  test("config set writes the repo file by default, keeping its other keys; null removes a key", () => {
    const cwd = repo("git@github.com:acme-co/app.git", { ".fbs/config.json": '{"camp":{"autoFixRounds":3}}' });
    const r = fbs(cwd, "config", "set", "tracker", '{"kind":"github"}');
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ set: "tracker", level: "repo", path: join(cwd, ".fbs/config.json") });
    expect(JSON.parse(readFileSync(join(cwd, ".fbs/config.json"), "utf8"))).toEqual({ camp: { autoFixRounds: 3 }, tracker: { kind: "github" } });
    expect(fbs(cwd, "config", "set", "camp.autoFixRounds", "null").code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, ".fbs/config.json"), "utf8"))).toEqual({ tracker: { kind: "github" } });
  });

  test("config set --owner writes origin's owner block and --user the defaults, in the user file", () => {
    const cwd = repo("https://github.com/acme-co/app.git");
    const path = userFile({ owners: { other: { tracker: { kind: "github" } } } });
    expect(fbs(cwd, "config", "set", "docs.publish", '{"kind":"notion","parent":"1a2b"}', "--owner").json()).toEqual({ set: "docs.publish", level: "owner:acme-co", path });
    expect(fbs(cwd, "config", "set", "docs.store", '"tracked"', "--user").json()).toEqual({ set: "docs.store", level: "user", path });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ owners: { other: { tracker: { kind: "github" } }, "acme-co": { docs: { publish: { kind: "notion", parent: "1a2b" } } } }, defaults: { docs: { store: "tracked" } } });
    expect(fbs(cwd, "config", "show").json().sources.docs).toBe("owner:acme-co+user");
  });

  test("config set --user creates the user file when there is none", () => {
    const cwd = repo();
    expect(fbs(cwd, "config", "set", "branches.types", '["feat","fix"]', "--user").code).toBe(0);
    expect(JSON.parse(readFileSync(join(xdg, "fbs", "config.json"), "utf8"))).toEqual({ defaults: { branches: { types: ["feat", "fix"] } } });
    expect(readdirSync(join(xdg, "fbs"))).toEqual(["config.json"]);
  });

  test.each<[string[], string]>([
    [["tracker", '{"kind":"jira"}'], "tracker"],
    [["docs.store", '"shared"'], "docs"],
    [["docs.store", "local"], "JSON"],
    [["nope", "1"], "nope"],
    [["docs.nope", "1"], "docs.nope"],
    [["tracker.kind", '"github"'], "tracker.kind"],
    [["verify.ciEvidence", "true"], "verify.ciWorkflows"],
  ])("config set %j is refused and writes nothing", (args, reason) => {
    const cwd = repo(undefined, { ".fbs/config.json": "{}" });
    const r = fbs(cwd, "config", "set", ...args);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain(reason);
    expect(readFileSync(join(cwd, ".fbs/config.json"), "utf8")).toBe("{}");
  });

  test("config set --owner without an owner in origin's URL, both levels, or missing arguments are refused", () => {
    const cwd = repo();
    expect(fbs(cwd, "config", "set", "docs.store", '"local"', "--owner").err.join("\n")).toContain("owner");
    expect(fbs(cwd, "config", "set", "docs.store", '"local"', "--owner", "--user").code).toBe(2);
    expect(fbs(cwd, "config", "set", "docs.store").code).toBe(2);
    expect(existsSync(join(xdg, "fbs", "config.json"))).toBe(false);
  });

  test("docs.store local puts the features folder in info/exclude the first time, so the documents are local", () => {
    const cwd = repo("git@github.com:acme-co/app.git", { ".fbs/config.json": '{"featuresDir":"specs/features"}' });
    const exclude = join(cwd, ".git", "info", "exclude");
    const excluded = () => readFileSync(exclude, "utf8").split("\n").filter((line) => line === "/specs/features/");
    expect(fbs(cwd, "config", "set", "docs.store", '"local"').json()).toEqual({ set: "docs.store", level: "repo", path: join(cwd, ".fbs/config.json"), excluded: "/specs/features/" });
    expect(excluded()).toHaveLength(1);
    expect(fbs(cwd, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(fbs(cwd, "status", "show", "paid-plans").json()).toMatchObject({ docs: "local" });
    expect(excluded()).toHaveLength(1);
  });

  test("status init excludes the features folder when docs.store local comes from the user file; an ignored folder is left alone", () => {
    userFile({ owners: { "acme-co": { docs: { store: "local" } } } });
    const cwd = repo("git@github.com:acme-co/app.git");
    expect(fbs(cwd, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(fbs(cwd, "status", "show", "paid-plans").json()).toMatchObject({ docs: "local" });
    expect(readFileSync(join(cwd, ".git", "info", "exclude"), "utf8")).toContain("/docs/features/\n");
    const ignored = repo("git@github.com:acme-co/app.git", { ".gitignore": "docs/features/\n" });
    const excludeBefore = readFileSync(join(ignored, ".git", "info", "exclude"), "utf8");
    expect(fbs(ignored, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(readFileSync(join(ignored, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
  });

  test("a ./ features folder is normalised, so its exclude line works and is written once", () => {
    const cwd = repo(undefined, { ".fbs/config.json": '{"featuresDir":"./docs/features/"}' });
    expect(fbs(cwd, "config", "show").json().featuresDir).toBe("docs/features");
    expect(fbs(cwd, "config", "set", "docs.store", '"local"').json().excluded).toBe("/docs/features/");
    expect(fbs(cwd, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(fbs(cwd, "status", "init", "free-plans", "--size", "mid").code).toBe(0);
    expect(fbs(cwd, "status", "show", "paid-plans").json()).toMatchObject({ dir: "docs/features/2026-10-21-paid-plans", docs: "local" });
    expect(readFileSync(join(cwd, ".git", "info", "exclude"), "utf8").split("\n").filter((line) => line.includes("features"))).toEqual(["/docs/features/"]);
  });

  test("excluded is printed only by the call that added the line; a line already there is never added again", () => {
    const cwd = repo(undefined, { ".gitignore": "!/docs/features/\n" });
    const exclude = join(cwd, ".git", "info", "exclude");
    expect(fbs(cwd, "config", "set", "docs.store", '"local"').json().excluded).toBe("/docs/features/");
    expect(fbs(cwd, "config", "set", "docs.store", '"local"').json().excluded).toBeUndefined();
    expect(fbs(cwd, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(readFileSync(exclude, "utf8").split("\n").filter((line) => line === "/docs/features/")).toHaveLength(1);
  });

  test("config show warns when docs.store is tracked but git ignores the features folder", () => {
    const cwd = repo(undefined, { ".gitignore": "docs/features/\n", ".fbs/config.json": '{"docs":{"store":"tracked"}}' });
    const r = fbs(cwd, "config", "show");
    expect(r.code).toBe(0);
    expect(r.err).toEqual(["warning: docs.store is tracked, but git ignores docs/features/, so the documents stay local: git's ignore wins"]);
    expect(fbs(repo(undefined, { ".fbs/config.json": '{"docs":{"store":"tracked"}}' }), "config", "show").err).toEqual([]);
  });

  test("status move into a repo whose docs.store is local excludes its features folder first", () => {
    const source = repo();
    expect(fbs(source, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    const target = repo(undefined, { ".fbs/config.json": '{"docs":{"store":"local"}}' });
    expect(fbs(source, "status", "move", "paid-plans", "--to", target).json()).toMatchObject({ docs: "local" });
    expect(readFileSync(join(target, ".git", "info", "exclude"), "utf8")).toContain("/docs/features/\n");
  });

  test("without docs.store, the documents mode is detected as before", () => {
    const cwd = repo();
    expect(fbs(cwd, "status", "init", "paid-plans", "--size", "mid").code).toBe(0);
    expect(fbs(cwd, "status", "show", "paid-plans").json()).toMatchObject({ docs: "tracked" });
  });
});
