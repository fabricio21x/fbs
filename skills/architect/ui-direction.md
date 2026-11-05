# UI direction

Read this from architect step 7 when the feature has screens: anything a user sees or uses in a browser or app. It produces the design's `## UI direction` section and the mockups: the brief every UI task is built and reviewed against.

## 1. Context, once per project

- A project design skill comes first: when the project has its own (for example a `<project>-design` skill, or `.claude/skills/*design*`), load it and follow it.
- Load `impeccable` with the Skill tool for the product context. It designs from a `PRODUCT.md` (users, brand, tone, anti-references) and, when present, a `DESIGN.md` (colours, type, components). When its context loader script isn't at the path it names, read those two files directly.
- `PRODUCT.md` missing or a placeholder: run its `teach` command. Its questions go to the user through `fbs:grilling`'s rules (the question UI when available); facts the spec and `CLAUDE.md` already hold are passed in, not asked again.
- `DESIGN.md` missing on a project that already has a UI: suggest its `document` command once; don't block on it.
- Whatever `teach` or `document` writes (`PRODUCT.md`, `DESIGN.md`, a `CLAUDE.md` addition) is committed with the design in step 10.

When `impeccable` isn't installed, say so in one line and write the section yourself from step 4.

## 2. Shape this feature, with the user

Run `impeccable`'s `shape` command for the feature's screens, with the spec's acceptance criteria and the design's data shapes as input. Its discovery questions go to the user in architect's grilling round (step 6), not as a separate interview. `shape` then needs the user to approve its brief before anything is built: that approval is asked explicitly, and it is the user's approval of the UI direction, recorded in the decision log (`- <date>: UI brief approved. Why: user, <date>.`). The design approval later covers the brief again together with everything else.

The brief's open questions go to the design's top-level `## Open questions`, never under the UI section, where a heading with "question" in it would be read by the gate.

## 3. Mock up the screens

For each screen, write `<dir>/mockups/<screen>.html`: a static, self-contained page (inline CSS, or the project's own styles and component look; no backend calls) with realistic sample data from the spec, every state the screen has (a small switcher between empty, loading, error and filled works well), and real copy. Open each in the browser (Chrome DevTools MCP: `new_page`, then `emulate` with the viewport `375x812x2,mobile,touch`, and again at `1280x800`) and refine it against the brief, at most two rounds. The mockups are the visual target: the overview embeds them, and UI tasks are built and reviewed against them.

## 4. Write the section

`## UI direction` in `design.md` (Mid: a `### UI direction` subsection of the spec's Design). Keep `shape`'s brief as written, all its parts (design direction, primary action, interaction model, key states, references and the rest), and add what an implementer needs that it doesn't say:

- **Mockups:** `mockups/<screen>.html` for each screen.
- **Layout:** structure at 375 px and 1280 px, and what changes between them.
- **Components:** from the project's own library first (shadcn/ui, a design system); name any new one.
- **Accessibility:** keyboard reachable, labelled controls, contrast, focus visible.

No sub-heading inside the section may contain "question", "assumption" or "fact".

## 5. Show it

- **Big:** the overview's UI section shows the brief's design direction and key states in a few lines, and embeds each mockup at both widths.
- **Mid:** there is no overview, so step 9's summary includes the design direction and key states, and opens each mockup in the user's browser (`open <dir>/mockups/<screen>.html` on macOS).
