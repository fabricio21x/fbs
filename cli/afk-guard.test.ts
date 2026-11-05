import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afkGuard, type Flag } from "./afk-guard";
import { DEFAULT_CONFIG, type FbsConfig, loadConfig } from "./config";
import { GitError } from "./git";
import { isolatedGitEnv } from "./test-env";

let repo: string;
let start: string;

function git(...args: string[]): string {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd: repo, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(): void {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "step");
}

const BASE = {
  "src/app.ts": "export const a = 1;\n",
  "src/app.test.ts": 'import { expect, test } from "bun:test";\n\ntest("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n',
  "package.json": JSON.stringify({ name: "x", scripts: { test: "bun test" }, dependencies: { zod: "^3.0.0" } }, null, 2),
  "README.md": "# x\n",
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fbs-afk-guard-"));
  git("init", "-q");
  write(BASE);
  commit();
  start = git("rev-parse", "HEAD");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Commit `files` (null deletes) on top of the start commit and run the guard. */
function guard(files: Record<string, string | null>, opts: { scope?: string[]; protectedFiles?: string[]; checkScripts?: string[]; config?: Pick<FbsConfig, "afk"> } = {}): Flag[] {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(repo, path));
    else write({ [path]: content });
  }
  commit();
  return afkGuard(repo, { start, scope: opts.scope ?? ["**"], protectedFiles: opts.protectedFiles ?? [], checkScripts: opts.checkScripts }, opts.config ?? DEFAULT_CONFIG).flags;
}

function kinds(flags: Flag[]): string[] {
  return flags.map((flag) => `${flag.kind} ${flag.path}${flag.line === undefined ? "" : `:${flag.line}`}`);
}

function pkg(extra: Record<string, unknown>): string {
  return JSON.stringify({ name: "x", scripts: { test: "bun test" }, dependencies: { zod: "^3.0.0" }, ...extra }, null, 2);
}

test("a normal source edit in scope has no flags", () => {
  expect(guard({ "src/app.ts": "export const a = 2;\nexport const b = 3;\n" }, { scope: ["src/**"] })).toEqual([]);
});

test("a new test file has no flags", () => {
  expect(guard({ "src/b.test.ts": 'test("b", () => {\n  expect(true).toBe(true);\n});\n' })).toEqual([]);
});

test("an assertion changed in place has no flags", () => {
  expect(guard({ "src/app.test.ts": BASE["src/app.test.ts"].replace("toBe(2)", "toEqual(2)") })).toEqual([]);
});

test("no commits since start has no flags", () => {
  expect(afkGuard(repo, { start, scope: [], protectedFiles: [] }, DEFAULT_CONFIG).flags).toEqual([]);
});

test("an unknown start commit is a GitError", () => {
  expect(() => afkGuard(repo, { start: "0".repeat(40), scope: [], protectedFiles: [] }, DEFAULT_CONFIG)).toThrow(GitError);
});

test("a file outside the scope is out-of-scope", () => {
  expect(kinds(guard({ "src/app.ts": "x\n", "lib/util.ts": "y\n" }, { scope: ["src/**"] }))).toEqual(["out-of-scope lib/util.ts"]);
});

test("a renamed file is checked at both paths", () => {
  mkdirSync(join(repo, "lib"));
  git("mv", "src/app.ts", "lib/app.ts");
  expect(kinds(guard({}, { scope: ["src/**"] }))).toEqual(["out-of-scope lib/app.ts"]);
});

test("a changed protected file is protected", () => {
  expect(kinds(guard({ "src/app.ts": "x\n" }, { protectedFiles: ["src/app.ts"] }))).toEqual(["protected src/app.ts"]);
});

test("a deleted protected file is protected", () => {
  expect(kinds(guard({ "README.md": null }, { protectedFiles: ["README.md"] }))).toEqual(["protected README.md"]);
});

test("a new file beside the protected ones is not protected", () => {
  expect(kinds(guard({ "src/b.test.ts": 'test("b", () => {\n  expect(1).toBe(1);\n});\n' }, { protectedFiles: ["src/app.test.ts"] }))).toEqual([]);
});

test("a new package.json dependency is flagged with its line", () => {
  const flags = guard({ "package.json": pkg({ devDependencies: { vitest: "^2.0.0" } }) });
  expect(flags).toEqual([{ kind: "dependency", path: "package.json", line: 10, detail: "adds the dependency vitest" }]);
});

test.each(["dependencies", "peerDependencies", "optionalDependencies"])("a new key in %s is a dependency", (section) => {
  const deps = section === "dependencies" ? { zod: "^3.0.0", left: "1" } : { left: "1" };
  const flags = guard({ "package.json": pkg(section === "dependencies" ? { dependencies: deps } : { [section]: deps }) });
  expect(flags.map((flag) => flag.detail)).toEqual(["adds the dependency left"]);
});

test("a package.json version bump has no flags", () => {
  expect(guard({ "package.json": pkg({ dependencies: { zod: "^3.1.0" } }) })).toEqual([]);
});

test("a package.json scripts edit is check-config, not a dependency", () => {
  expect(kinds(guard({ "package.json": pkg({ scripts: { test: "exit 0" } }) }))).toEqual(["check-config package.json"]);
});

test("a package.json that doesn't parse is a dependency flag", () => {
  expect(kinds(guard({ "package.json": "{ nope" }))).toEqual(["dependency package.json"]);
});

test("a new package.json in a subfolder counts all its dependencies", () => {
  expect(kinds(guard({ "web/package.json": JSON.stringify({ dependencies: { react: "19" } }, null, 2) }))).toEqual(["dependency web/package.json:3"]);
});

test.each(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "go.sum", "Cargo.lock", "Gemfile.lock", "composer.lock", "Pipfile.lock"])(
  "a changed %s is a dependency",
  (lockfile) => {
    expect(kinds(guard({ [lockfile]: "lock\n" }))).toEqual([`dependency ${lockfile}`]);
  },
);

test("a new requirement is a dependency, a pin change is not", () => {
  write({ "requirements-dev.txt": "# tools\nFlask==2.0\n" });
  commit();
  start = git("rev-parse", "HEAD");
  expect(guard({ "requirements-dev.txt": "# tools\nFlask==2.1\n" })).toEqual([]);
  start = git("rev-parse", "HEAD");
  expect(kinds(guard({ "requirements-dev.txt": "# tools\nFlask==2.1\nrequests>=2\n" }))).toEqual(["dependency requirements-dev.txt:3"]);
});

test("a new go.mod require is a dependency, in a block or on one line", () => {
  write({ "go.mod": "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/a v1.0.0\n)\n" });
  commit();
  start = git("rev-parse", "HEAD");
  const flags = guard({ "go.mod": "module x\n\ngo 1.23\n\nrequire (\n\tgithub.com/a/a v1.1.0\n\tgithub.com/b/b v1.0.0 // indirect\n)\n\nrequire github.com/c/c v0.1.0\n" });
  expect(flags.map((flag) => `${flag.detail}:${flag.line}`)).toEqual(["adds the dependency github.com/b/b:7", "adds the dependency github.com/c/c:10"]);
});

test("pyproject, Cargo.toml, Pipfile, Gemfile and composer.json read their dependency sections", () => {
  write({
    "pyproject.toml": '[project]\nname = "x"\ndependencies = ["httpx>=0.27"]\n\n[tool.black]\nline-length = 100\n',
    "Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n',
    Pipfile: '[packages]\nflask = "*"\n',
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "composer.json": JSON.stringify({ require: { "php": ">=8" } }),
  });
  commit();
  start = git("rev-parse", "HEAD");
  expect(guard({ "pyproject.toml": '[project]\nname = "x"\ndependencies = ["httpx>=0.28"]\n\n[tool.black]\nline-length = 120\n' })).toEqual([]);
  start = git("rev-parse", "HEAD");
  const flags = guard({
    "pyproject.toml": '[project]\nname = "x"\ndependencies = ["httpx>=0.28", "Rich_Text[x]>=1"]\n\n[project.optional-dependencies]\ndev = ["pytest"]\n',
    "Cargo.toml": '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies.tokio]\nversion = "1"\n',
    Pipfile: '[packages]\nflask = "*"\n\n[dev-packages]\nblack = "*"\n',
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "pry", group: :development\n',
    "composer.json": JSON.stringify({ require: { php: ">=8" }, "require-dev": { "phpunit/phpunit": "^11" } }),
  });
  expect(flags.map((flag) => `${flag.path} ${flag.detail}`)).toEqual([
    "Cargo.toml adds the dependency tokio",
    "Gemfile adds the dependency pry",
    "Pipfile adds the dependency black",
    "composer.json adds the dependency phpunit/phpunit",
    "pyproject.toml adds the dependency rich-text",
    "pyproject.toml adds the dependency pytest",
  ]);
});

test.each(["db/migrations/0002_add_users.sql", "db/migrate/20261028_add_users.rb", "prisma/migrations/1/migration.sql", "drizzle/0001.sql", "supabase/migrations/1.sql", "alembic/versions/abc.py", "prisma/schema.prisma"])(
  "%s is a migration",
  (path) => {
    expect(kinds(guard({ [path]: "x\n" }))).toEqual([`migration ${path}`]);
  },
);

test.each([
  "Dockerfile",
  "api/Dockerfile.prod",
  "docker-compose.yml",
  ".github/workflows/ci.yml",
  "infra/main.tf",
  "terraform/vars.json",
  "vercel.json",
  "fly.toml",
  "railway.json",
  "railway.toml",
  "netlify.toml",
  "render.yaml",
  "k8s/deploy.yaml",
  "helm/values.yaml",
  "Procfile",
])("%s is infra", (path) => {
  expect(kinds(guard({ [path]: "x\n" }))).toEqual([`infra ${path}`]);
});

test("config adds migration and infra globs", () => {
  const config = { afk: { migrations: ["sql/**"], infra: ["deploy/*.sh"] } };
  expect(kinds(guard({ "sql/0001.sql": "x\n", "deploy/up.sh": "y\n" }, { config }))).toEqual(["infra deploy/up.sh", "migration sql/0001.sql"]);
});

test("the afk keys in .fbs/config.json reach the guard", () => {
  write({ ".fbs/config.json": JSON.stringify({ afk: { migrations: ["sql/**"], deny: ["vercel --prod"] } }) });
  commit();
  start = git("rev-parse", "HEAD");
  const config = loadConfig(repo);
  expect(config.afk).toEqual({ migrations: ["sql/**"], deny: ["vercel --prod"] });
  expect(kinds(guard({ "sql/0001.sql": "x\n" }, { config, scope: ["sql/**"] }))).toEqual(["migration sql/0001.sql"]);
});

test.each([
  ["test.skip(", '  test.skip("b", () => {});'],
  ["it.only(", '  it.only("b", () => {});'],
  ["describe.skip(", 'describe.skip("all", () => {});'],
  ["xit(", '  xit("b", () => {});'],
  ["xdescribe(", 'xdescribe("all", () => {});'],
  ["test.todo(", '  test.todo("b");'],
  ["test.skipIf(", '  test.skipIf(ci)("b", () => {});'],
  ["test.fails", '  test.fails("b", () => {});'],
])("an added %s in a test file is test-weakening", (_, line) => {
  const flags = guard({ "src/app.test.ts": `${BASE["src/app.test.ts"]}${line}\n` });
  expect(kinds(flags)).toEqual(["test-weakening src/app.test.ts:7"]);
});

test("a .skip( outside a test file is not test-weakening", () => {
  expect(guard({ "src/app.ts": "export const s = list.skip(2);\n" })).toEqual([]);
});

test.each(["test/app.ts", "tests/app.py", "__tests__/app.js", "e2e/login.ts", "src/app.spec.ts", "pkg/app_test.go"])("%s is a test file", (path) => {
  expect(kinds(guard({ [path]: 'it.only("b", () => {});\n' }))).toEqual([`test-weakening ${path}:1`]);
});

test.each([
  ["// @ts-ignore", "src/app.ts"],
  ["// @ts-expect-error", "src/app.ts"],
  ["// @ts-nocheck", "src/app.ts"],
  ["// eslint-disable-next-line no-console", "src/app.ts"],
  ["x = f()  # type: ignore", "src/app.py"],
  ["import os  # noqa: F401", "src/app.py"],
  ["@pytest.mark.skip(reason='flaky')", "tests/test_app.py"],
])("an added %p is test-weakening", (line, path) => {
  expect(kinds(guard({ [path]: `${line}\n` }))).toEqual([`test-weakening ${path}:1`]);
});

test("a pattern mentioned in markdown is not test-weakening", () => {
  expect(guard({ "README.md": "# x\n\nNever add `@ts-ignore` or `.only(`.\n" })).toEqual([]);
});

test("a deleted test file is test-weakening", () => {
  expect(guard({ "src/app.test.ts": null })).toEqual([{ kind: "test-weakening", path: "src/app.test.ts", detail: "a test file was deleted" }]);
});

test("a removed assertion in an existing test is test-weakening for the file", () => {
  const flags = guard({ "src/app.test.ts": BASE["src/app.test.ts"].replace("  expect(2).toBe(2);\n", "") });
  expect(flags).toEqual([{ kind: "test-weakening", path: "src/app.test.ts", detail: "net 1 assertion or test case lines removed (1 removed, 0 added) (heuristic, may be a false positive)" }]);
});

test("a removed test case is test-weakening even when other lines are added", () => {
  const content = 'import { expect, test } from "bun:test";\n\nconst helper = 1;\n';
  expect(kinds(guard({ "src/app.test.ts": content }))).toEqual(["test-weakening src/app.test.ts"]);
});

test("moving an assertion within a test is not test-weakening", () => {
  const swapped = BASE["src/app.test.ts"].replace("  expect(1).toBe(1);\n  expect(2).toBe(2);\n", "  expect(2).toBe(2);\n  expect(1).toBe(1);\n");
  expect(guard({ "src/app.test.ts": swapped })).toEqual([]);
});

test("a path with a space or non-ASCII letters is checked line by line", () => {
  const flags = guard({ "src/my app.test.ts": `${BASE["src/app.test.ts"]}test.skip("b", () => {});\n`, "src/café.test.ts": 'test.only("c", () => {});\n' });
  expect(kinds(flags)).toEqual(["test-weakening src/café.test.ts:1", "test-weakening src/my app.test.ts:7"]);
});

test("a NUL byte doesn't hide a test file's lines", () => {
  expect(kinds(guard({ "src/app.test.ts": `${BASE["src/app.test.ts"]}test.skip("b", () => {}); // \0\n` }))).toEqual(["test-weakening src/app.test.ts:7"]);
});

test("a .gitattributes that marks tests binary is check-config and doesn't hide their lines", () => {
  const flags = guard({ ".gitattributes": "*.ts -diff\n", "src/app.test.ts": `${BASE["src/app.test.ts"]}test.skip("b", () => {});\n` });
  expect(kinds(flags)).toEqual(["check-config .gitattributes", "test-weakening src/app.test.ts:7"]);
});

test("a test file changed with no readable lines is test-weakening", () => {
  chmodSync(join(repo, "src/app.test.ts"), 0o755);
  expect(kinds(guard({}))).toEqual(["test-weakening src/app.test.ts"]);
});

test("a test renamed out of the test patterns is test-weakening", () => {
  git("mv", "src/app.test.ts", "src/app.tset.ts");
  expect(guard({}).map((flag) => flag.detail)).toEqual(["a test file was renamed out of the test patterns, so the runner may no longer find it"]);
});

test("a test renamed out with an assertion dropped is checked for net removal", () => {
  git("mv", "src/app.test.ts", "src/app.ts.bak");
  const flags = guard({ "src/app.ts.bak": BASE["src/app.test.ts"].replace("  expect(2).toBe(2);\n", "") });
  expect(kinds(flags)).toEqual(["test-weakening src/app.ts.bak", "test-weakening src/app.ts.bak"]);
});

test("a test file replaced by a symlink is test-weakening", () => {
  write({ "src/empty.ts": "" });
  rmSync(join(repo, "src/app.test.ts"));
  symlinkSync("empty.ts", join(repo, "src/app.test.ts"));
  expect(guard({}).map((flag) => flag.detail)).toEqual(["a test file was replaced by a symlink or submodule"]);
});

test("commenting out an assertion is test-weakening and doesn't count as an assertion", () => {
  const flags = guard({ "src/app.test.ts": BASE["src/app.test.ts"].replace("  expect(2).toBe(2);", "  // expect(2).toBe(2);") });
  expect(kinds(flags)).toEqual(["test-weakening src/app.test.ts:5", "test-weakening src/app.test.ts"]);
  expect(flags[0].detail).toContain("comments out an assertion or test");
});

test("removing a commented-out assertion has no flags", () => {
  write({ "src/app.test.ts": `${BASE["src/app.test.ts"]}// expect(3).toBe(3);\n` });
  commit();
  start = git("rev-parse", "HEAD");
  expect(guard({ "src/app.test.ts": BASE["src/app.test.ts"] })).toEqual([]);
});

test.each([
  "bunfig.toml",
  "jest.config.js",
  "vitest.config.ts",
  "playwright.config.ts",
  "cypress.config.ts",
  "karma.conf.js",
  ".mocharc.yml",
  "pytest.ini",
  "setup.cfg",
  "tox.ini",
  "tsconfig.json",
  "tsconfig.build.json",
  ".eslintrc.json",
  "eslint.config.js",
  "biome.json",
  "biome.jsonc",
  "Makefile",
  "justfile",
  "Taskfile.yml",
  "ruff.toml",
  ".ruff.toml",
  "mypy.ini",
  ".coveragerc",
  ".flake8",
  "pyrightconfig.json",
  ".eslintignore",
  ".nycrc.json",
  "lighthouserc.json",
  ".gitattributes",
])("%s is check-config", (path) => {
  expect(kinds(guard({ [path]: "x\n" }))).toEqual([`check-config ${path}`]);
});

test("a conftest.py is check-config", () => {
  expect(kinds(guard({ "src/conftest.py": "x = 1\n" }))).toEqual(["check-config src/conftest.py"]);
});

test("a pyproject test or lint section change is check-config, another tool's is not", () => {
  write({ "pyproject.toml": '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.black]\nline-length = 88\n' });
  commit();
  start = git("rev-parse", "HEAD");
  expect(guard({ "pyproject.toml": '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.black]\nline-length = 100\n' })).toEqual([]);
  start = git("rev-parse", "HEAD");
  for (const section of ['[tool.pytest.ini_options]\naddopts = "-k not slow"', "[tool.coverage.run]\nomit = []", "[tool.mypy]\nstrict = false", "[tool.ruff]\nline-length = 1"]) {
    const flags = guard({ "pyproject.toml": `[project]\nname = "x"\n\n[tool.black]\nline-length = 100\n\n${section}\n` });
    expect(kinds(flags)).toEqual(["check-config pyproject.toml"]);
    git("reset", "-q", "--hard", start);
  }
});

test("config adds check-config globs", () => {
  expect(kinds(guard({ "ci/thresholds.yml": "x\n" }, { config: { afk: { checkConfig: ["ci/*.yml"] } } }))).toEqual(["check-config ci/thresholds.yml"]);
});

test.each([
  ["test.skip.each(", 'test.skip.each([1])("b %p", () => {});'],
  ["it.only.each(", 'it.only.each([1])("b %p", () => {});'],
  ['test["skip"](', 'test["skip"]("b", () => {});'],
  ["test.if(false)", 'test.if(false)("b", () => {});'],
  ["test.failing(", 'test.failing("b", () => {});'],
  ["fit(", 'fit("c", () => {});'],
  ["fdescribe(", 'fdescribe("c", () => {});'],
  ["test.fail(", '  test.fail();'],
  ["test.fixme(", 'test.fixme("c", async () => {});'],
])("an added %s in a test file is test-weakening", (_, line) => {
  expect(kinds(guard({ "src/app.test.ts": `${BASE["src/app.test.ts"]}${line}\n` }))).toEqual(["test-weakening src/app.test.ts:7"]);
});

test.each([
  ["t.Skip(", "pkg/a_test.go", "\tt.Skip()"],
  ["@pytest.mark.xfail", "tests/test_a.py", "@pytest.mark.xfail"],
  ["pytest.skip(", "tests/test_a.py", "    pytest.skip('later')"],
  ["@unittest.skip", "tests/test_a.py", "@unittest.skip('x')"],
  ["#[ignore]", "src/lib.rs", "#[ignore]"],
  ["biome-ignore", "src/app.ts", "// biome-ignore lint: x"],
  ["# pylint: disable", "src/app.py", "x = 1  # pylint: disable=unused"],
  ["istanbul ignore", "src/app.ts", "/* istanbul ignore next */"],
  ["c8 ignore", "src/app.ts", "/* c8 ignore next */"],
  ["xit in an rspec spec", "spec/user_spec.rb", "xit 'a' do"],
])("an added %s is test-weakening", (_, path, line) => {
  expect(kinds(guard({ [path]: `${line}\n` }))).toEqual([`test-weakening ${path}:1`]);
});

test("a .skip( call that isn't a test modifier has no flags", () => {
  expect(guard({ "src/app.test.ts": `${BASE["src/app.test.ts"]}const page = await db.find().skip(10);\n` })).toEqual([]);
});

test("line pattern flags say they are heuristics", () => {
  expect(guard({ "src/app.ts": "// @ts-ignore\n" })[0].detail).toContain("heuristic");
});

test("a new name in requirements/dev.txt is a dependency", () => {
  expect(kinds(guard({ "requirements/dev.txt": "requests\n" }))).toEqual(["dependency requirements/dev.txt:1"]);
});

test("a new uv dev-dependency is a dependency", () => {
  expect(guard({ "pyproject.toml": '[project]\nname = "x"\n\n[tool.uv]\ndev-dependencies = ["pytest"]\n' }).map((flag) => flag.detail)).toEqual(["adds the dependency pytest"]);
});

test("a new go.mod replace is a dependency", () => {
  write({ "go.mod": "module x\n\nrequire github.com/a/a v1.0.0\n" });
  commit();
  start = git("rev-parse", "HEAD");
  const flags = guard({ "go.mod": "module x\n\nrequire github.com/a/a v1.0.0\n\nreplace github.com/a/a => ../fork\n" });
  expect(kinds(flags)).toEqual(["dependency go.mod:5"]);
});

test("a new submodule is a dependency", () => {
  write({ ".gitmodules": '[submodule "v"]\n\tpath = vendor/lib\n\turl = https://example.com/lib\n' });
  git("add", ".gitmodules");
  git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
  git("commit", "-q", "-m", "submodule");
  expect(kinds(afkGuard(repo, { start, scope: ["**"], protectedFiles: [] }, DEFAULT_CONFIG).flags)).toEqual(["dependency .gitmodules", "dependency vendor/lib"]);
});

test.each([".gitlab-ci.yml", ".circleci/config.yml", ".github/actions/setup/action.yml", "wrangler.toml", "serverless.yml"])("%s is infra", (path) => {
  expect(kinds(guard({ [path]: "x\n" }))).toEqual([`infra ${path}`]);
});

test.each(["db/schema.rb", "prisma/models/user.prisma"])("%s is a migration", (path) => {
  expect(kinds(guard({ [path]: "x\n" }))).toEqual([`migration ${path}`]);
});

test.each(["src/app.test.ts.bak", "src/app.test.md"])("a test renamed to %s is test-weakening", (to) => {
  git("mv", "src/app.test.ts", to);
  expect(guard({}).map((flag) => flag.detail)).toEqual(["a test file was renamed to another extension, so the runner may no longer find it"]);
});

test("a test renamed within its extension has no flags", () => {
  git("mv", "src/app.test.ts", "src/main.test.ts");
  expect(guard({})).toEqual([]);
});

test.each([
  ["/*", "*/"],
  ["/**", " */"],
])("wrapping an existing test in %s ... %s is test-weakening", (open, close) => {
  const wrapped = BASE["src/app.test.ts"].replace('test("a"', `${open}\ntest("a"`).replace("});\n", `});\n${close}\n`);
  expect(kinds(guard({ "src/app.test.ts": wrapped }))).toEqual(["test-weakening src/app.test.ts:3"]);
});

test("wrapping an existing Python test in a docstring is test-weakening", () => {
  write({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n" });
  commit();
  start = git("rev-parse", "HEAD");
  expect(kinds(guard({ "tests/test_a.py": '"""\ndef test_a():\n    assert 1 == 1\n"""\n' }))).toEqual(["test-weakening tests/test_a.py:1"]);
});

test("a new block comment or docstring in an existing test has no flags", () => {
  const withDocs = BASE["src/app.test.ts"].replace('test("a"', '/**\n * Checks a.\n */\ntest("a"');
  expect(guard({ "src/app.test.ts": withDocs })).toEqual([]);
  write({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n" });
  commit();
  start = git("rev-parse", "HEAD");
  expect(guard({ "tests/test_a.py": 'def test_a():\n    """\n    Checks a.\n    """\n    assert 1 == 1\n' })).toEqual([]);
});

test("a prose comment that mentions assert has no flags, in a new or an existing test", () => {
  expect(guard({ "src/b.test.ts": "// assert the cache is warm\n" })).toEqual([]);
  expect(guard({ "src/app.test.ts": `${BASE["src/app.test.ts"]}// assert the cache is warm\n` })).toEqual([]);
});

test("a removed Python assert statement is net removal", () => {
  write({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n    assert 2 == 2\n" });
  commit();
  start = git("rev-parse", "HEAD");
  expect(kinds(guard({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n" }))).toEqual(["test-weakening tests/test_a.py"]);
});

test("a .Skip( call outside a test file has no flags", () => {
  expect(guard({ "src/Repo.cs": "var page = query.Skip(10).Take(10);\n" })).toEqual([]);
});

test("model.fit( in a test has no flags", () => {
  expect(guard({ "tests/test_model.py": "def test_fit():\n    model.fit(X, y)\n    assert model\n" })).toEqual([]);
});

test("a package.json script that isn't a check has no flags", () => {
  expect(guard({ "package.json": pkg({ scripts: { test: "bun test", dev: "vite", build: "tsc" } }) })).toEqual([]);
});

test.each(["test:unit", "lint", "check", "typecheck", "type-check", "coverage", "e2e", "ci", "pretest"])("a new %s script is check-config", (name) => {
  expect(kinds(guard({ "package.json": pkg({ scripts: { test: "bun test", [name]: "exit 0" } }) }))).toEqual(["check-config package.json"]);
});

test("a script the recorded checks call is check-config", () => {
  write({ "package.json": pkg({ scripts: { test: "bun test", seo: "lighthouse" } }) });
  commit();
  start = git("rev-parse", "HEAD");
  const flags = guard({ "package.json": pkg({ scripts: { test: "bun test", seo: "echo 100" } }) }, { checkScripts: ["seo"] });
  expect(kinds(flags)).toEqual(["check-config package.json"]);
});

test.each(["jest", "eslintConfig"])("a package.json %s change is check-config", (key) => {
  expect(kinds(guard({ "package.json": pkg({ [key]: { rules: {} } }) }))).toEqual(["check-config package.json"]);
});

test.each(["vite.config.ts", ".prettierrc"])("%s has no flags", (path) => {
  expect(guard({ [path]: "x\n" })).toEqual([]);
});

test("lines stay with their file around a typechange and a mode change", () => {
  write({ "src/b.ts": "b\n", "src/c.ts": "c\n" });
  commit();
  start = git("rev-parse", "HEAD");
  rmSync(join(repo, "src/b.ts"));
  symlinkSync("c.ts", join(repo, "src/b.ts"));
  chmodSync(join(repo, "src/c.ts"), 0o755);
  expect(kinds(guard({ "src/d.test.ts": 'test.only("d", () => {});\n', "src/a.ts": "// @ts-ignore\n" }))).toEqual(["test-weakening src/a.ts:1", "test-weakening src/d.test.ts:1"]);
});
