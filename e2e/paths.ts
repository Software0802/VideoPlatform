import path from "node:path";

/**
 * Where `auth.setup.ts` leaves the logged-in cookie for the other projects.
 * Kept in its own module because `playwright.config.ts` needs the value too, and
 * importing a file that calls `test()` from the config is not allowed.
 *
 * Deliberately outside `test-results/`: that directory is wiped at the start of
 * a run, and it also holds the isolated `DATA_DIR`.
 */
export const STORAGE_STATE = path.join(__dirname, ".auth/session.json");

/**
 * Which `DATA_DIR` the running server turned out to read, written by
 * `auth.setup.ts` once registration succeeded. Other specs need it to mint an
 * invite the server will actually see.
 */
export const DATA_DIR_HINT = path.join(__dirname, ".auth/data-dir.txt");
