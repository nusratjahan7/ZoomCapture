// Tests the Windows controls helper on the real desktop (`npm run test:native`, Windows only):
// the native messaging protocol, that Windows leaves its window out of screen captures, and that
// its buttons send commands; then the same with the extension in Chrome. A small window appears
// briefly near the bottom of the screen.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runExtensionTest } from './extension.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
if (process.platform !== 'win32') {
  console.log('The controls helper is Windows only: skipped.');
  process.exit(0);
}

const powershell = (file, args) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' }).trim();
const probe = (args) =>
  JSON.parse(
    powershell(join(ROOT, 'tests', 'native', 'probe.ps1'), args)
      .split('\n')
      .at(-1),
  );

/** Starts the helper the way Chrome does and speaks its length-prefixed JSON protocol. */
function startHelper(exe, extraArgs = []) {
  const child = spawn(exe, ['chrome-extension://test/', ...extraArgs], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const messages = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
      const length = buffer.readInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      messages.push(message);
      for (const waiter of [...waiters]) waiter();
    }
  });
  const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));
  return {
    pid: child.pid,
    exited,
    send(message) {
      const body = Buffer.from(JSON.stringify(message), 'utf8');
      const header = Buffer.alloc(4);
      header.writeInt32LE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
    },
    next(predicate, timeoutMs = 5000) {
      return new Promise((resolveNext, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for a helper message')), timeoutMs);
        const check = () => {
          const index = messages.findIndex(predicate);
          if (index < 0) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolveNext(messages.splice(index, 1)[0]);
        };
        waiters.push(check);
        check();
      });
    },
    close() {
      child.stdin.end();
      return exited;
    },
  };
}

const results = [];
async function test(name, run) {
  try {
    await run();
    results.push(true);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push(false);
    console.log(
      `  ✗ ${name}\n    ${String(error?.stack ?? error)
        .split('\n')
        .slice(0, 4)
        .join('\n    ')}`,
    );
  }
}

const dir = mkdtempSync(join(tmpdir(), 'zc-native-'));
const exe = powershell(join(ROOT, 'native', 'windows', 'install.ps1'), ['-BuildOnly', '-InstallDir', dir])
  .split('\n')
  .at(-1)
  .trim();
const state = {
  phase: 'recording',
  elapsedMs: 3000,
  micAvailable: true,
  micMuted: false,
};

await test('protocol: ready, ping, show, and it quits when Chrome closes the connection', async () => {
  const helper = startHelper(exe);
  const ready = await helper.next((m) => m.type === 'ready');
  assert.equal(ready.version, '1.0.0');
  assert.equal(ready.excluded, true, 'window excluded from capture');
  helper.send({ type: 'ping' });
  assert.equal((await helper.next((m) => m.type === 'pong')).excluded, true);
  helper.send({ type: 'show', ...state });
  assert.equal(probe(['-Action', 'Capture', '-ProcessId', helper.pid]).found, true, 'window shown');
  assert.equal(await helper.close(), 0, 'exits when the connection closes');
});

await test('capture: on screen, but left out of a screen capture', async () => {
  // Control: the same window allowed into captures shows up in the screenshot…
  const visible = startHelper(exe, ['--include-in-capture']);
  assert.equal((await visible.next((m) => m.type === 'ready')).excluded, false);
  visible.send({ type: 'show', ...state });
  const seen = probe(['-Action', 'Capture', '-ProcessId', visible.pid]);
  await visible.close();
  assert.ok(seen.dark > 0.6 && seen.white < 0.1, `control window captured: ${JSON.stringify(seen)}`);
  // …while the real one is not: the screenshot shows the white window underneath instead.
  const hidden = startHelper(exe);
  await hidden.next((m) => m.type === 'ready');
  hidden.send({ type: 'show', ...state });
  const unseen = probe(['-Action', 'Capture', '-ProcessId', hidden.pid]);
  await hidden.close();
  assert.ok(unseen.white > 0.9, `left out of the capture: ${JSON.stringify(unseen)}`);
});

await test('buttons: pause, mute and stop send commands; state changes the buttons', async () => {
  const helper = startHelper(exe);
  try {
    await helper.next((m) => m.type === 'ready');
    helper.send({ type: 'show', ...state });
    assert.equal(probe(['-Action', 'Click', '-Name', 'Pause recording', '-ProcessId', helper.pid]).clicked, true);
    assert.equal((await helper.next((m) => m.type === 'command')).action, 'pause');
    helper.send({ type: 'state', ...state, phase: 'paused' });
    assert.equal(probe(['-Action', 'Click', '-Name', 'Resume recording', '-ProcessId', helper.pid]).clicked, true);
    assert.equal((await helper.next((m) => m.type === 'command')).action, 'resume');
    assert.equal(probe(['-Action', 'Click', '-Name', 'Mute microphone', '-ProcessId', helper.pid]).clicked, true);
    assert.equal((await helper.next((m) => m.type === 'command')).action, 'toggleMic');
    helper.send({ type: 'state', ...state, micMuted: true });
    assert.equal(probe(['-Action', 'Click', '-Name', 'Unmute microphone', '-ProcessId', helper.pid]).clicked, true);
    assert.equal((await helper.next((m) => m.type === 'command')).action, 'toggleMic');
    assert.equal(probe(['-Action', 'Click', '-Name', 'Stop recording', '-ProcessId', helper.pid]).clicked, true);
    assert.equal((await helper.next((m) => m.type === 'command')).action, 'stop');
    // Without a microphone there is no mute button.
    helper.send({ type: 'state', ...state, micAvailable: false });
    assert.equal(probe(['-Action', 'Click', '-Name', 'Mute microphone', '-ProcessId', helper.pid]).clicked, false);
  } finally {
    await helper.close();
  }
});

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// With the extension in Chrome (needs `npm run build` first).
await runExtensionTest(test, { powershell, probe });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
