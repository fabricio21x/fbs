import { posix } from "node:path";
import type { FbsConfig } from "./config";
import { commitOf, fileInTree, GitError, gitOutput } from "./git";

export type FlagKind = "dependency" | "migration" | "infra" | "check-config" | "out-of-scope" | "protected" | "test-weakening";

/** One reason to stop an afk run; `line` is in the file at HEAD, except where `detail` says otherwise. */
export interface Flag {
  kind: FlagKind;
  path: string;
  line?: number;
  detail: string;
}

export interface AfkGuardInput {
  start: string;
  scope: string[];
  /** The repo-relative files protected at the start; new files beside them aren't protected. */
  protectedFiles: string[];
  /** package.json scripts the recorded checks call, watched like the check-named ones. */
  checkScripts?: string[];
}

const MIGRATION_GLOBS = ["**/migrations/**", "**/migrate/**", "**/drizzle/**", "**/alembic/versions/**", "**/*.prisma", "**/db/schema.rb"];

const INFRA_GLOBS = [
  "**/Dockerfile*",
  "**/*.dockerfile",
  "**/docker-compose*",
  "**/compose.yml",
  "**/compose.yaml",
  ".github/workflows/**",
  ".github/actions/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "**/*.tf",
  "**/*.tfvars",
  "**/terraform/**",
  "**/vercel.json",
  "**/fly.toml",
  "**/railway.json",
  "**/railway.toml",
  "**/netlify.toml",
  "**/render.yaml",
  "**/wrangler.toml",
  "**/serverless.yml",
  "**/serverless.yaml",
  "**/k8s/**",
  "**/helm/**",
  "**/Procfile",
];

// Config that decides what the checks run or how strict they are: the cheapest way to fake a finish line.
const CHECK_CONFIG_GLOBS = [
  "**/bunfig.toml",
  "**/jest.config.*",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/karma.conf.*",
  "**/.mocharc*",
  "**/pytest.ini",
  "**/conftest.py",
  "**/setup.cfg",
  "**/tox.ini",
  "**/tsconfig*.json",
  "**/.eslintrc*",
  "**/eslint.config.*",
  "**/biome.json",
  "**/biome.jsonc",
  "**/lighthouserc*",
  "**/.lighthouserc*",
  "**/.gitattributes",
  "**/Makefile",
  "**/justfile",
  "**/Justfile",
  "**/Taskfile.yml",
  "**/Taskfile.yaml",
  "**/ruff.toml",
  "**/.ruff.toml",
  "**/mypy.ini",
  "**/.mypy.ini",
  "**/.coveragerc",
  "**/.flake8",
  "**/pyrightconfig.json",
  "**/.eslintignore",
  "**/.nycrc*",
];

const TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/*_spec.rb",
  "**/test_*.py",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/spec/**",
  "**/e2e/**",
];

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
]);

const GITLINK = "160000";

const HEURISTIC = "(heuristic, may be a false positive)";

const TEST_FILE_PATTERNS: [RegExp, string][] = [
  [/\b(test|it|describe|context|suite|bench)\b(\.\w+|\[["']\w+["']\])*(\.|\[["'])(skip|only|todo|fail|failing|fails|fixme|skipIf|todoIf|if|runIf)\b/, "skips, focuses or todos a test"],
  [/(^|\s)[xf](it|describe|context|test|specify)\b\s*[("'`]/, "skips or focuses a test"],
  [/\.Skip(f|Now)?\s*\(/, "skips a test"],
];

const SOURCE_PATTERNS: [RegExp, string][] = [
  [/@ts-(ignore|expect-error|nocheck)\b/, "silences the type checker"],
  [/#\s*type:\s*ignore/, "silences the type checker"],
  [/eslint-disable|biome-ignore|#\s*noqa\b|#\s*pylint:\s*disable/i, "silences the linter"],
  [/\b(istanbul|c8) ignore\b/, "excludes code from coverage"],
  [/\bpytest\.(mark\.(skip|skipif|xfail)|skip|xfail)\b|\bunittest\.(skip|expectedFailure)|#\[ignore\b/, "skips a test"],
];

const ASSERTION = /\bexpect\s*\(|\bassert(_\w+|[A-Z]\w*)?\s*[(!.]|^\s*assert\s|\b(it|test)(\.each)?\s*\(|\bdef test_|\bfunc Test/;

const COMMENT = /^\s*(\/\/|#|\*|\/\*|<!--)/;

/** Block comment openers at the start of a line, each with its closer. */
const BLOCK_COMMENTS: { open: RegExp; close: string }[] = [
  { open: /^\s*\/\*/, close: "*/" },
  { open: /^\s*"""/, close: '"""' },
  { open: /^\s*\'\'\'/, close: "\'\'\'" },
  { open: /^=begin\b/, close: "=end" },
];

// Prose that mentions a pattern isn't a weakening.
const PROSE = /\.(md|mdx)$/i;

interface Change {
  status: string;
  path: string;
  oldPath?: string;
  oldMode: string;
  newMode: string;
}

interface FileHunks {
  added: { line: number; text: string }[];
  removed: { line: number; text: string }[];
}

/** The flags `start..HEAD` raises for an afk run with this scope and these protected files. */
export function afkGuard(cwd: string, input: AfkGuardInput, config: Pick<FbsConfig, "afk">): { flags: Flag[] } {
  if (commitOf(cwd, input.start) === null) throw new GitError(`unknown start commit ${input.start}`);
  const migrations = [...MIGRATION_GLOBS, ...(config.afk?.migrations ?? [])];
  const infra = [...INFRA_GLOBS, ...(config.afk?.infra ?? [])];
  const checkConfig = [...CHECK_CONFIG_GLOBS, ...(config.afk?.checkConfig ?? [])];

  const changes = changedFiles(cwd, input.start);
  const hunks = diffHunks(cwd, input.start, changes);
  const flags: Flag[] = [];
  for (const [i, change] of changes.entries()) {
    const paths = change.oldPath === undefined ? [change.path] : [change.oldPath, change.path];
    for (const path of paths) {
      if (!matchesAny(input.scope, path)) flags.push({ kind: "out-of-scope", path, detail: "outside the run's scope" });
      if (input.protectedFiles.includes(path)) flags.push({ kind: "protected", path, detail: "a protected file changed" });
      if (matchesAny(migrations, path)) flags.push({ kind: "migration", path, detail: "a migration or schema file changed" });
      if (matchesAny(infra, path)) flags.push({ kind: "infra", path, detail: "infrastructure or deploy config changed" });
      if (matchesAny(checkConfig, path)) flags.push({ kind: "check-config", path, detail: "test, lint or check config changed" });
      if (LOCKFILES.has(posix.basename(path))) flags.push({ kind: "dependency", path, detail: "a lockfile changed" });
      if (path === ".gitmodules") flags.push({ kind: "dependency", path, detail: "the submodules changed" });
    }
    if (change.oldMode === GITLINK || change.newMode === GITLINK) flags.push({ kind: "dependency", path: change.path, detail: "a submodule changed" });
    if (change.status !== "D") flags.push(...manifestFlags(cwd, input.start, change, input.checkScripts ?? []));
    flags.push(...testWeakening(change, hunks[i]));
  }
  return { flags };
}

function matchesAny(globs: string[], path: string): boolean {
  return globs.some((glob) => new Bun.Glob(glob).match(path));
}

function isTestFile(path: string): boolean {
  return matchesAny(TEST_GLOBS, path);
}

function testWeakening(change: Change, hunks: FileHunks): Flag[] {
  const { status, path } = change;
  const oldPath = change.oldPath ?? path;
  const wasTest = isTestFile(oldPath);
  if (wasTest && status === "D") return [{ kind: "test-weakening", path, detail: "a test file was deleted" }];
  if (wasTest && status === "T") return [{ kind: "test-weakening", path, detail: "a test file was replaced by a symlink or submodule" }];
  if (status === "D" || status === "T" || (PROSE.test(path) && !wasTest)) return [];

  const flags: Flag[] = [];
  if (status === "R" && wasTest) {
    if (posix.extname(oldPath) !== posix.extname(path)) flags.push({ kind: "test-weakening", path, detail: "a test file was renamed to another extension, so the runner may no longer find it" });
    else if (!isTestFile(path)) flags.push({ kind: "test-weakening", path, detail: "a test file was renamed out of the test patterns, so the runner may no longer find it" });
  }
  const existingTest = wasTest && (status === "M" || status === "R");
  if (existingTest && status === "M" && hunks.added.length + hunks.removed.length === 0) {
    flags.push({ kind: "test-weakening", path, detail: "a test file changed with no readable line changes" });
  }
  const test = wasTest || isTestFile(path);
  const patterns = test ? [...TEST_FILE_PATTERNS, ...SOURCE_PATTERNS] : SOURCE_PATTERNS;
  const wrapping = existingTest ? blockCommentsOverExistingLines(hunks.added) : new Set<number>();
  for (const { line, text } of hunks.added) {
    let hit = patterns.find(([pattern]) => pattern.test(text))?.[1];
    if (existingTest && COMMENT.test(text) && ASSERTION.test(text)) hit = "comments out an assertion or test";
    if (wrapping.has(line)) hit = "opens a block comment over existing lines";
    if (hit) flags.push({ kind: "test-weakening", path, line, detail: `${hit}: ${text.trim()} ${HEURISTIC}` });
  }
  if (existingTest) {
    const counts = (lines: FileHunks["added"]) => lines.filter(({ text }) => !COMMENT.test(text) && ASSERTION.test(text)).length;
    const removed = counts(hunks.removed);
    const added = counts(hunks.added);
    if (removed > added) {
      flags.push({ kind: "test-weakening", path, detail: `net ${removed - added} assertion or test case lines removed (${removed} removed, ${added} added) ${HEURISTIC}` });
    }
  }
  return flags;
}

/** Added lines that open a block comment whose body takes in lines that were already there. */
function blockCommentsOverExistingLines(added: FileHunks["added"]): Set<number> {
  const addedLines = new Set(added.map(({ line }) => line));
  const flagged = new Set<number>();
  const closers = new Set<number>();
  for (const [i, { line, text }] of added.entries()) {
    if (closers.has(line)) continue;
    const block = BLOCK_COMMENTS.find(({ open }) => open.test(text));
    if (block === undefined) continue;
    const rest = text.slice(text.search(block.open) + text.match(block.open)![0].length);
    if (rest.includes(block.close)) continue;
    const closer = added.slice(i + 1).find(({ text: later }) => later.includes(block.close));
    if (closer !== undefined) closers.add(closer.line);
    const end = closer?.line ?? Number.POSITIVE_INFINITY;
    let fresh = closer !== undefined;
    for (let n = line + 1; fresh && n < end; n++) fresh = addedLines.has(n);
    if (!fresh) flagged.add(line);
  }
  return flagged;
}

type DependencyReader = (content: string) => string[];

const DEPENDENCY_READERS: { match: (path: string) => boolean; read: DependencyReader }[] = [
  { match: (path) => posix.basename(path) === "package.json", read: jsonSections(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) },
  { match: (path) => posix.basename(path) === "composer.json", read: jsonSections(["require", "require-dev"]) },
  { match: (path) => /^requirements.*\.txt$/.test(posix.basename(path)) || /(^|\/)requirements\/.*\.txt$/.test(path), read: requirementsTxt },
  { match: (path) => posix.basename(path) === "pyproject.toml", read: pyproject },
  { match: (path) => posix.basename(path) === "Pipfile", read: (content) => tomlTables(content, ["packages", "dev-packages"]).map(pythonName) },
  { match: (path) => posix.basename(path) === "Cargo.toml", read: cargoToml },
  { match: (path) => posix.basename(path) === "go.mod", read: goMod },
  { match: (path) => posix.basename(path) === "Gemfile", read: gemfile },
];

/** The part of a manifest that holds check config, compared as a whole. */
const CHECK_CONFIG_READERS: { match: (path: string) => boolean; read: (content: string, checkScripts: string[]) => unknown }[] = [
  { match: (path) => posix.basename(path) === "package.json", read: packageCheckConfig },
  { match: (path) => posix.basename(path) === "pyproject.toml", read: pyprojectCheckSections },
];

const CHECK_SCRIPT = /^(pre|post)?(test|lint|check|typecheck|type-check|coverage|e2e|ci)/;

function packageCheckConfig(content: string, checkScripts: string[]): unknown {
  const manifest = record(JSON.parse(content || "{}"));
  const scripts = Object.entries(record(manifest.scripts)).filter(([name]) => CHECK_SCRIPT.test(name) || checkScripts.includes(name));
  return { scripts, jest: manifest.jest, eslintConfig: manifest.eslintConfig };
}

function manifestFlags(cwd: string, start: string, change: Change, checkScripts: string[]): Flag[] {
  const reader = DEPENDENCY_READERS.find(({ match }) => match(change.path));
  const checkReader = CHECK_CONFIG_READERS.find(({ match }) => match(change.path));
  if (reader === undefined && checkReader === undefined) return [];
  const after = fileInTree(cwd, "HEAD", change.path);
  if (after.kind !== "file") return [];
  const before = fileInTree(cwd, start, change.oldPath ?? change.path);
  const beforeContent = before.kind === "file" ? before.content : null;
  const flags: Flag[] = [];
  if (reader !== undefined) flags.push(...newDependencies(change.path, reader.read, beforeContent, after.content));
  if (checkReader !== undefined) {
    // A missing file reads as empty, so a new manifest is flagged only when it has check config.
    const read = (content: string) => {
      try {
        return JSON.stringify(checkReader.read(content, checkScripts));
      } catch {
        return undefined;
      }
    };
    const now = read(after.content);
    // A manifest that doesn't parse is already a dependency flag.
    if (now !== undefined && now !== read(beforeContent ?? "")) flags.push({ kind: "check-config", path: change.path, detail: "test, lint or check config in the manifest changed" });
  }
  return flags;
}

function newDependencies(path: string, read: DependencyReader, before: string | null, after: string): Flag[] {
  let names: string[];
  try {
    names = read(after);
  } catch {
    return [{ kind: "dependency", path, detail: "the manifest doesn't parse, so its dependencies can't be checked" }];
  }
  let known: Set<string>;
  try {
    known = new Set(before === null ? [] : read(before));
  } catch {
    known = new Set();
  }
  return names
    .filter((name) => !known.has(name))
    .map((name) => ({ kind: "dependency" as const, path, line: lineOf(after, name), detail: `adds the dependency ${name}` }));
}

function lineOf(content: string, name: string): number | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = content.split("\n");
  for (const pattern of [new RegExp(`["']${escaped}["']\\s*[:=]`), new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w.-])`, "i")]) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index !== -1) return index + 1;
  }
  return undefined;
}

function jsonSections(sections: string[]): DependencyReader {
  return (content) => {
    const manifest = JSON.parse(content);
    return sections.flatMap((section) => (isRecord(manifest?.[section]) ? Object.keys(manifest[section]) : []));
  };
}

function pythonName(spec: string): string {
  return spec.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The distribution name a PEP 508 requirement starts with. */
function requirementName(spec: string): string {
  return pythonName(spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? spec.trim());
}

function requirementsTxt(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => (line.startsWith("-") ? line : requirementName(line)));
}

function pyproject(content: string): string[] {
  const toml = Bun.TOML.parse(content) as Record<string, unknown>;
  const project = record(toml.project);
  const poetry = record(record(toml.tool).poetry);
  const specs = [
    ...strings(project.dependencies),
    ...Object.values(record(project["optional-dependencies"])).flatMap(strings),
    ...Object.values(record(toml["dependency-groups"])).flatMap(strings),
    ...strings(record(record(toml.tool).uv)["dev-dependencies"]),
  ].map(requirementName);
  const poetryNames = [
    ...Object.keys(record(poetry.dependencies)).filter((name) => name !== "python"),
    ...Object.keys(record(poetry["dev-dependencies"])),
    ...Object.values(record(poetry.group)).flatMap((group) => Object.keys(record(record(group).dependencies))),
  ].map(pythonName);
  return [...specs, ...poetryNames];
}

function pyprojectCheckSections(content: string): unknown {
  const tool = record((Bun.TOML.parse(content) as Record<string, unknown>).tool);
  return Object.entries(tool).filter(([name]) => /^(pytest|coverage|mypy|ruff)/.test(name));
}

function cargoToml(content: string): string[] {
  const toml = Bun.TOML.parse(content) as Record<string, unknown>;
  const sections = ["dependencies", "dev-dependencies", "build-dependencies"];
  const tables = [toml, record(toml.workspace), ...Object.values(record(toml.target)).map(record)];
  return tables.flatMap((table) => sections.flatMap((section) => Object.keys(record(table[section]))));
}

function tomlTables(content: string, tables: string[]): string[] {
  const toml = Bun.TOML.parse(content) as Record<string, unknown>;
  return tables.flatMap((table) => Object.keys(record(toml[table])));
}

function goMod(content: string): string[] {
  const modules: string[] = [];
  let block: string | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const directive = line.match(/^(require|replace)\s*(\(?)\s*(.*)$/);
    if (block !== null) {
      if (line === ")") block = null;
      else if (line !== "") modules.push(goModule(block, line));
    } else if (directive?.[2] === "(") block = directive[1];
    else if (directive) modules.push(goModule(directive[1], directive[3]));
  }
  return modules;
}

function goModule(directive: string, spec: string): string {
  const module = spec.split(/\s+/)[0];
  return directive === "replace" ? `replace ${module}` : module;
}

function gemfile(content: string): string[] {
  return [...content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((match) => match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Pinned so user config can't change the paths, the order or the shape of the entries the two diffs list.
const DIFF_FLAGS = ["--find-renames", "--no-relative", "--submodule=short", "--ignore-submodules=none", "--no-ext-diff", "--no-textconv", "--no-color"];

function changedFiles(cwd: string, start: string): Change[] {
  const fields = gitOutput(cwd, ["diff", "--raw", "-z", ...DIFF_FLAGS, start, "HEAD", "--"]).split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length && fields[i] !== ""; ) {
    const [oldMode, newMode, , , score] = fields[i].slice(1).split(" ");
    const status = score[0];
    if (status === "R" || status === "C") {
      changes.push({ status, oldPath: status === "R" ? fields[i + 1] : undefined, path: fields[i + 2], oldMode, newMode });
      i += 3;
    } else {
      changes.push({ status, path: fields[i + 1], oldMode, newMode });
      i += 2;
    }
  }
  return changes;
}

/**
 * The added and removed lines of each change, in the order of `changes`, from one zero-context diff that reads
 * every file as text. Its `diff --git` entries follow the raw list's order; a typechange is two entries.
 */
function diffHunks(cwd: string, start: string, changes: Change[]): FileHunks[] {
  const out = gitOutput(cwd, ["diff", "-U0", "--text", ...DIFF_FLAGS, start, "HEAD", "--"]);
  const entries: FileHunks[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) entries.push({ added: [], removed: [] });
    const header = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const current = entries.at(-1);
    if (!header || current === undefined) continue;
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    let removeLeft = header[2] === undefined ? 1 : Number(header[2]);
    let addLeft = header[4] === undefined ? 1 : Number(header[4]);
    // Count the hunk's lines, so a body line that looks like a header isn't read as one.
    while (removeLeft + addLeft > 0 && i + 1 < lines.length) {
      const body = lines[++i];
      if (body.startsWith("-")) {
        current.removed.push({ line: oldLine++, text: body.slice(1) });
        removeLeft--;
      } else if (body.startsWith("+")) {
        current.added.push({ line: newLine++, text: body.slice(1) });
        addLeft--;
      }
    }
  }
  const expected = changes.reduce((sum, change) => sum + (change.status === "T" ? 2 : 1), 0);
  if (entries.length !== expected) throw new GitError(`the diff of ${start}..HEAD has ${entries.length} entries for ${changes.length} changed files`);
  let next = 0;
  return changes.map((change) => {
    const taken = entries.slice(next, (next += change.status === "T" ? 2 : 1));
    return { added: taken.flatMap((entry) => entry.added), removed: taken.flatMap((entry) => entry.removed) };
  });
}
