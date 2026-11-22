import { expect, test } from "bun:test";
import { acceptanceCriteria, criterionBlocks, parseWorkUnits, unitSection, workUnitProblems } from "./work-units";

const SPEC = [
  "# Booking sync",
  "## Scope",
  "- [ ] not a criterion",
  "## Acceptance criteria",
  "<!-- One `- [ ] <criterion>` line each. -->",
  "- [ ] A member sees the booking time",
  "- [x] The host gets a reminder",
  "- [ ] The owner can turn reminders off",
  "## Facts",
  "None",
].join("\n");

const unit = (heading: string, covers: string | null, dependsOn: string | null) =>
  [
    `### ${heading}`,
    ...(covers === null ? [] : [`- Covers: ${covers}`]),
    ...(dependsOn === null ? [] : [`- Depends on: ${dependsOn}`]),
    "- Ships: something a reviewer sees",
    "- Files: cli/x.ts",
  ].join("\n");

const design = (...units: string[]) => `# Design\n## Test seams\nNone\n## Work units\n${units.join("\n\n")}\n## Risks\n### U9: not a unit\nNone\n`;

const GOOD = design(unit("U1: Booking time", "AC1", "none"), unit("U2: Reminders", "AC2, AC3", "U1"));

test("the spec's acceptance criteria are the checkbox lines under its section, struck-through ones dropped", () => {
  expect(acceptanceCriteria(SPEC)).toEqual([
    { text: "A member sees the booking time", dropped: false, rollout: false },
    { text: "The host gets a reminder", dropped: false, rollout: false },
    { text: "The owner can turn reminders off", dropped: false, rollout: false },
  ]);
  expect(acceptanceCriteria("## Acceptance criteria\n- [ ] ~~Old one~~ (dropped 2026-10-28)\n- [x] Kept, with ~~a struck word~~\n")).toEqual([
    { text: "~~Old one~~ (dropped 2026-10-28)", dropped: true, rollout: false },
    { text: "Kept, with ~~a struck word~~", dropped: false, rollout: false },
  ]);
  expect(acceptanceCriteria("## Scope\n- [ ] x\n")).toEqual([]);
});

test("a criterion that starts with (rollout) is checked after the deploy; struck through, it is dropped instead", () => {
  expect(acceptanceCriteria("## Acceptance criteria\n- [ ] (rollout) A copy works between environments\n- [ ] (Rollout) Clients deploy through it\n- [ ] A note (rollout) later\n- [ ] ~~(rollout) Old~~\n")).toEqual([
    { text: "(rollout) A copy works between environments", dropped: false, rollout: true },
    { text: "(Rollout) Clients deploy through it", dropped: false, rollout: true },
    { text: "A note (rollout) later", dropped: false, rollout: false },
    { text: "~~(rollout) Old~~", dropped: true, rollout: false },
  ]);
});

test("a unit's section is its heading and lines up to the next unit or section, without trailing blank lines; null when missing", () => {
  expect(unitSection(GOOD, 1)).toBe(unit("U1: Booking time", "AC1", "none"));
  expect(unitSection(GOOD, 2)).toBe(unit("U2: Reminders", "AC2, AC3", "U1"));
  expect(unitSection(GOOD, 3)).toBeNull();
  expect(unitSection(GOOD, 9)).toBeNull();
  expect(unitSection("# Design\n", 1)).toBeNull();
});

test("a unit's section keeps its fenced blocks and comments as written, and a heading inside a fence doesn't end it", () => {
  const withFence = (field: string) => design(`${unit("U1: Booking time", "AC1", "none")}\n\`\`\`ts\n### U2: not a heading\ninterface Booking { ${field}: string }\n\`\`\`\n<!-- keep the zone -->`, unit("U2: Reminders", "AC2, AC3", "U1"));
  expect(unitSection(withFence("at"), 1)).toContain("### U2: not a heading\ninterface Booking { at: string }");
  expect(unitSection(withFence("at"), 1)).toEndWith("<!-- keep the zone -->");
  expect(unitSection(withFence("at"), 1)).not.toBe(unitSection(withFence("startsAt"), 1));
  expect(unitSection(withFence("at"), 2)).toBe(unitSection(withFence("startsAt"), 2));
});

test("a duplicate unit heading has no section, and a renamed or renumbered heading changes it", () => {
  expect(unitSection(design(unit("U1: Booking time", "AC1", "none"), unit("U1: Again", "AC2, AC3", "none")), 1)).toBeNull();
  expect(unitSection(design(unit("U1: Booking times", "AC1", "none")), 1)).not.toBe(unitSection(GOOD, 1));
  expect(unitSection(design(unit("U2: Booking time", "AC1", "none")), 1)).toBeNull();
});

test("a criterion's block is its line and every line under it up to the next criterion", () => {
  const spec = "## Acceptance criteria\n<!-- intro -->\n- [ ] A member sees the booking time\n  - in their own zone\n\n- [ ] The host gets a reminder\n## Facts\nNone\n";
  expect(criterionBlocks(spec)).toEqual(["- [ ] A member sees the booking time\n  - in their own zone", "- [ ] The host gets a reminder"]);
});

const DROPPED_SPEC = SPEC.replace("- [x] The host gets a reminder", "- [x] ~~The host gets a reminder~~");

test("a dropped criterion keeps its position and needs no unit", () => {
  expect(workUnitProblems(design(unit("U1: Booking time", "AC1", "none"), unit("U2: Opt out", "AC3", "U1")), DROPPED_SPEC)).toEqual([]);
});

test("a unit covering a dropped criterion is reported", () => {
  expect(workUnitProblems(design(unit("U1: Booking time", "AC1, AC2", "none"), unit("U2: Opt out", "AC3", "U1")), DROPPED_SPEC)).toEqual([
    "U1 covers AC2, which the spec dropped",
  ]);
});

test("a good split parses into its units and passes", () => {
  expect(parseWorkUnits(GOOD)).toEqual({
    units: [
      { number: 1, name: "Booking time", covers: [1], dependsOn: [] },
      { number: 2, name: "Reminders", covers: [2, 3], dependsOn: [1] },
    ],
    problems: [],
  });
  expect(workUnitProblems(GOOD, SPEC)).toEqual([]);
});

test("a setup unit covers none, and a unit may depend on several lower ones", () => {
  const split = design(unit("U1: Schema", "none", "none"), unit("U2: Booking time", "AC1, AC2", "U1"), unit("U3: Opt out", "ac3", "U1, U2"));
  expect(workUnitProblems(split, SPEC)).toEqual([]);
  expect(parseWorkUnits(split).units?.[2]).toEqual({ number: 3, name: "Opt out", covers: [3], dependsOn: [1, 2] });
});

test("None passes with no units, and a design without the section passes with null", () => {
  expect(parseWorkUnits("## Work units\n<!-- the PRs -->\nNone\n## Risks\n")).toEqual({ units: [], problems: [] });
  expect(workUnitProblems("## Work units\nNone.\n", SPEC)).toEqual([]);
  expect(parseWorkUnits("# Design\n## Test seams\nNone\n")).toEqual({ units: null, problems: [] });
  expect(workUnitProblems("# Design\n## Test seams\nNone\n", SPEC)).toEqual([]);
});

test("the template's multi-line comment is not read as a unit", () => {
  const template = "## Work units\n<!-- Per unit:\n### U<n>: <name>\n- Covers: AC<i>\n-->\nNone\n";
  expect(parseWorkUnits(template)).toEqual({ units: [], problems: [] });
});

test("an empty section or one without unit headings is a problem", () => {
  const hint = "write one ### U<n>: <name> per unit, or None when the feature ships as one PR";
  expect(workUnitProblems("## Work units\n\n## Risks\n", SPEC)).toEqual([hint]);
  expect(workUnitProblems("## Work units\nOne PR, U1.\n", SPEC)).toEqual([hint]);
});

test("an uncovered criterion is reported", () => {
  expect(workUnitProblems(design(unit("U1: Booking time", "AC1", "none"), unit("U2: Reminders", "AC2", "U1")), SPEC)).toEqual(["AC3 isn't covered by any unit"]);
});

test("a criterion covered twice is reported with both units", () => {
  expect(workUnitProblems(design(unit("U1: Booking time", "AC1, AC2", "none"), unit("U2: Reminders", "AC2, AC3", "U1")), SPEC)).toEqual([
    "AC2 is covered by U1, U2; each criterion belongs to exactly one unit",
  ]);
});

test("an unknown criterion is reported", () => {
  expect(workUnitProblems(design(unit("U1: All", "AC1, AC2, AC3, AC4", "none")), SPEC)).toEqual(["U1 covers AC4, but the spec has 3 acceptance criteria"]);
});

test("a dependency on a higher unit, itself or a missing unit is reported", () => {
  const split = design(unit("U1: Booking time", "AC1", "U2"), unit("U2: Reminders", "AC2", "U2"), unit("U3: Opt out", "AC3", "U7"));
  expect(workUnitProblems(split, SPEC)).toEqual([
    "U1 depends on U2; a unit depends only on lower-numbered units",
    "U2 depends on U2; a unit depends only on lower-numbered units",
    "U3 depends on U7, which isn't a unit",
  ]);
});

test("misnumbered or malformed headings are reported", () => {
  expect(workUnitProblems(design(unit("U1: Booking time", "AC1", "none"), unit("U3: Reminders", "AC2, AC3", "U1")), SPEC)).toEqual([
    "### U3: Reminders is out of order: expected U2",
  ]);
  expect(workUnitProblems(design(unit("U2: Booking time", "AC1", "none"), unit("U1: Reminders", "AC2, AC3", "none")), SPEC)).toEqual([
    "### U2: Booking time is out of order: expected U1",
    "### U1: Reminders is out of order: expected U2",
  ]);
  expect(workUnitProblems(design(unit("Booking time", "AC1", "none"), unit("U2 Reminders", "AC2, AC3", "U1")), SPEC)).toEqual([
    "### Booking time must be ### U1: <name>",
    "### U2 Reminders must be ### U2: <name>",
  ]);
});

test("a missing or repeated Covers or Depends on line is reported", () => {
  const split = design(unit("U1: Booking time", null, "none"), `${unit("U2: Reminders", "AC1, AC2", null)}\n- Covers: AC3`);
  expect(workUnitProblems(split, SPEC)).toEqual([
    'U1 needs exactly one "- Covers:" line, found 0',
    'U2 needs exactly one "- Covers:" line, found 2',
    'U2 needs exactly one "- Depends on:" line, found 0',
    "AC1 isn't covered by any unit",
    "AC2 isn't covered by any unit",
    "AC3 isn't covered by any unit",
  ]);
});

test("a Covers or Depends on line that isn't a reference list is reported", () => {
  const split = design(unit("U1: All", "AC1, criterion 2, AC3", "the schema"), unit("U2: More", "AC2", "U1;"));
  expect(workUnitProblems(split, SPEC)).toEqual([
    'U1 Covers: "AC1, criterion 2, AC3" must be AC<i> references separated by commas, or none',
    'U1 Depends on: "the schema" must be U<k> references separated by commas, or none',
    'U2 Depends on: "U1;" must be U<k> references separated by commas, or none',
    "AC1 isn't covered by any unit",
    "AC3 isn't covered by any unit",
  ]);
});
