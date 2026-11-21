for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Run inside Claude Code, the suite would otherwise bind camps and land requests to the session running it.
delete process.env.CLAUDE_CODE_SESSION_ID;
