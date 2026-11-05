import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig, type Tracker } from "./config";

let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

test("camp.autoFixRounds is kept", () => {
  expect(loadConfig(repoWithConfig('{"camp":{"autoFixRounds":3}}')).camp).toEqual({ autoFixRounds: 3 });
});

test.each(['{"camp":[]}', '{"camp":{"autoFixRounds":0}}', '{"camp":{"autoFixRounds":-1}}', '{"camp":{"autoFixRounds":1.5}}', '{"camp":{"autoFixRounds":"2"}}'])(
  "camp config %s is a ConfigError",
  (content) => {
    expect(() => loadConfig(repoWithConfig(content))).toThrow("camp");
  },
);
