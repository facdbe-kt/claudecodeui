import assert from 'node:assert/strict';
import test from 'node:test';

import {
  quoteRemotePathForShell,
  singleQuoteForShell,
} from '@/modules/websocket/services/shell-websocket.service.js';

// These helpers are SECURITY-CRITICAL: their output is interpolated into a
// remote `bash -ic '<script>'` command, so any breakout would mean arbitrary
// command execution on the remote host. The tests below assert both rejection
// of dangerous input and correct neutralization of single quotes. They are
// CI-safe: pure string functions, no SSH host, no network.

// ---------------------------------------------------------------------------
// quoteRemotePathForShell
// ---------------------------------------------------------------------------

test('quoteRemotePathForShell single-quotes a safe absolute path', () => {
  assert.equal(quoteRemotePathForShell('/home/zyx/project'), `'/home/zyx/project'`);
});

test('quoteRemotePathForShell single-quotes a path with spaces', () => {
  assert.equal(
    quoteRemotePathForShell('/home/zyx/my project dir'),
    `'/home/zyx/my project dir'`
  );
});

test('quoteRemotePathForShell escapes embedded single quotes with the close/escape/reopen idiom', () => {
  // O'Brien -> O'\''Brien wrapped in single quotes.
  assert.equal(quoteRemotePathForShell("/home/O'Brien"), `'/home/O'\\''Brien'`);
});

test('quoteRemotePathForShell leaves double quotes and dollar signs inert inside single quotes', () => {
  // `$HOME` and `"` are harmless once single-quoted (no `$(` and no backtick).
  assert.equal(quoteRemotePathForShell('/srv/$HOME/"x"'), `'/srv/$HOME/"x"'`);
});

test('quoteRemotePathForShell rejects newlines', () => {
  assert.throws(() => quoteRemotePathForShell('/tmp/a\nrm -rf /'), /Invalid remote project path/);
});

test('quoteRemotePathForShell rejects carriage returns and tabs', () => {
  assert.throws(() => quoteRemotePathForShell('/tmp/a\rb'), /Invalid remote project path/);
  assert.throws(() => quoteRemotePathForShell('/tmp/a\tb'), /Invalid remote project path/);
});

test('quoteRemotePathForShell rejects NUL and other control characters', () => {
  assert.throws(() => quoteRemotePathForShell('/tmp/a\u0000b'), /Invalid remote project path/);
  assert.throws(() => quoteRemotePathForShell('/tmp/a\u0007b'), /Invalid remote project path/);
  assert.throws(() => quoteRemotePathForShell('/tmp/a\u001bb'), /Invalid remote project path/);
  assert.throws(() => quoteRemotePathForShell('/tmp/a\u007fb'), /Invalid remote project path/);
});

test('quoteRemotePathForShell rejects backticks (command substitution)', () => {
  assert.throws(
    () => quoteRemotePathForShell('/tmp/`whoami`'),
    /Invalid remote project path/
  );
});

test('quoteRemotePathForShell rejects $( command substitution', () => {
  assert.throws(
    () => quoteRemotePathForShell('/tmp/$(rm -rf /)'),
    /Invalid remote project path/
  );
});

// ---------------------------------------------------------------------------
// singleQuoteForShell
// ---------------------------------------------------------------------------

test('singleQuoteForShell wraps a plain value in single quotes', () => {
  assert.equal(singleQuoteForShell('claude -p'), `'claude -p'`);
});

test('singleQuoteForShell renders an injection attempt inert as a single quoted argument', () => {
  const malicious = "x'; rm -rf /'";
  const quoted = singleQuoteForShell(malicious);

  // Expected: the embedded single quotes are escaped via '\'' so the whole
  // thing is ONE argument; the `; rm -rf /` never escapes the quoting.
  assert.equal(quoted, `'x'\\''; rm -rf /'\\'''`);

  // Structural guarantee: the result is a balanced single-quoted string whose
  // ONLY unescaped quotes are the '\'' boundary markers — there is no bare
  // top-level quote that would terminate the argument early.
  assertSingleSafelyQuotedArgument(quoted, malicious);
});

test('singleQuoteForShell neutralizes a leading-quote breakout attempt', () => {
  const malicious = "'; touch /tmp/pwned; echo '";
  const quoted = singleQuoteForShell(malicious);
  assertSingleSafelyQuotedArgument(quoted, malicious);
});

test('singleQuoteForShell handles a value that is only single quotes', () => {
  const quoted = singleQuoteForShell("'''");
  assertSingleSafelyQuotedArgument(quoted, "'''");
});

test('singleQuoteForShell composes with quoteRemotePathForShell output (nested quoting survives)', () => {
  const inner = quoteRemotePathForShell("/home/O'Brien/app");
  const script = `cd ${inner} && claude -p`;
  const quoted = singleQuoteForShell(script);
  assertSingleSafelyQuotedArgument(quoted, script);
});

/**
 * Asserts that `quoted` is a single, safely single-quoted shell argument that a
 * POSIX shell would parse back into exactly `original`.
 *
 * We simulate the shell's single-quote parser: the string must start and end
 * with `'`, and every `'` inside must be part of the `'\''` escape idiom. We
 * then "unquote" it the way the shell would and assert it equals the original
 * input — proving no metacharacters leaked into command position.
 */
function assertSingleSafelyQuotedArgument(quoted: string, original: string): void {
  assert.ok(quoted.startsWith("'"), 'must open with a single quote');
  assert.ok(quoted.endsWith("'"), 'must close with a single quote');

  // POSIX single-quote unquoting: outside quotes, only the `'\''` sequence may
  // appear; inside quotes everything is literal. Walk the string and rebuild
  // the original argument, failing if we ever see a bare quote in command
  // position (which would indicate a breakout).
  let i = 0;
  let inSingle = false;
  let rebuilt = '';

  while (i < quoted.length) {
    const ch = quoted[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        i += 1;
      } else {
        rebuilt += ch;
        i += 1;
      }
    } else {
      // Outside a single-quoted run, the only legal tokens are an opening quote
      // or the escaped-quote sequence `\'` (the middle of `'\''`).
      if (ch === "'") {
        inSingle = true;
        i += 1;
      } else if (ch === '\\' && quoted[i + 1] === "'") {
        rebuilt += "'";
        i += 2;
      } else {
        assert.fail(
          `unescaped shell metacharacter ${JSON.stringify(ch)} found in command position at index ${i}`
        );
      }
    }
  }

  assert.equal(inSingle, false, 'quoting must be balanced (no dangling open quote)');
  assert.equal(rebuilt, original, 'unquoted result must equal the original input');
}
