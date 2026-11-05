# Validation setup: <project>

<!-- Written by /fbs:setup-validation, read by /fbs:validate and /fbs:walkthrough. Every command here was run once end to end when the setup was written; the date of that run is below. Keep it short: an agent follows it step by step. -->

- Verified end to end: <YYYY-MM-DD>, <what ran: launch, health, one flow>

## Launch
<!-- The command that starts the app locally, how to run it in the background, the URL it serves, and the readiness signal to wait for (a log line, or a URL that answers 200), with a timeout. -->

## Health
<!-- One read-only check that says the app is up and wired (a health URL, a page title, an API call), and its expected result. -->

## Auth
<!-- How an agent signs in without a human: a test account and where its credentials come from (an env var name, never the secret), a dev-only bypass, or "the user signs in" when nothing else exists. -->

## Flows
<!-- One subsection per feature an agent may need to drive: how to reach it (URL or clicks), stable selectors (data-testid, roles, labels; never CSS paths), and the observable end state that shows it worked. -->

## Cleanup
<!-- How to stop everything Launch started, and any test data to remove. Close the browser pages you opened and kill what you started, nothing else. -->

## Helpers
<!-- Scripts under .fbs/validation/ (seeding, resetting, signing in), each with one line on what it does; or None. -->
