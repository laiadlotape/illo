/**
 * _helper.mjs — shared test utilities.
 *
 * Design choice: we import __test directly from the daemon module (pure
 * in-process) rather than spawning a child process. The daemon's HTTP server
 * is started on port 0 (OS-assigned) via the ILLO_SIDEBAR_PORT env var, and
 * the server is not exported, so the process would normally hang after tests.
 * We work around this by calling process.exit(0) inside an after() hook in the
 * test file. See server.test.mjs for the teardown pattern.
 *
 * This module just re-exports __test after forcing the env vars so the daemon
 * won't conflict with any real instance, and won't write to the user's home dir.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

// Must be set BEFORE the dynamic import resolves so the module-level code in
// server.js picks them up.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'illo-test-'));
process.env.ILLO_SIDEBAR_HOME = tmpDir;
process.env.ILLO_SIDEBAR_PORT = '0'; // OS-assigned port; avoids conflicts

// Dynamic import so that env vars are set first.
const { __test } = await import('../daemon/server.js');

export { __test, tmpDir };
