export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Fail loudly before serving a single request: a missing session secret must
  // never be papered over with a random or derived key (plan §3).
  const { assertSessionSecret } = await import("./lib/users/session");
  assertSessionSecret();
  // `data/users/index.json` is a derived cache; verify it against the user
  // directories at boot so a crash between the two writes cannot hide an account.
  const { ensureUserIndex } = await import("./lib/users/store");
  await ensureUserIndex();
  const { startJobRunner } = await import("./lib/jobs/runner");
  await startJobRunner();
}
