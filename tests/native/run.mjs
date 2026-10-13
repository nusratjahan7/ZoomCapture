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
    /** Resolves once the helper has handled everything sent so far (it handles messages in order). */
    async sync() {
      this.send({ type: 'ping' });
      await this.next((m) => m.type === 'pong');
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
        .slice(0, 8)
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
  assert.equal(ready.version, '1.2.0');
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
  /** Clicks a button and returns the command it sent; one retry if another window took the click. */
  const press = async (name) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(probe(['-Action', 'Click', '-Name', name, '-ProcessId', helper.pid]).clicked, true, `${name} clickable`);
      const command = await helper.next((m) => m.type === 'command', 2000).catch(() => null);
      if (command) return command.action;
    }
    throw new Error(`${name}: no command`);
  };
  try {
    await helper.next((m) => m.type === 'ready');
    helper.send({ type: 'show', ...state });
    assert.equal(await press('Pause recording'), 'pause');
    helper.send({ type: 'state', ...state, phase: 'paused' });
    await helper.sync();
    assert.equal(await press('Resume recording'), 'resume');
    assert.equal(await press('Mute microphone'), 'toggleMic');
    helper.send({ type: 'state', ...state, micMuted: true });
    await helper.sync();
    assert.equal(await press('Unmute microphone'), 'toggleMic');
    assert.equal(await press('Stop recording'), 'stop');
    // Without a microphone there is no mute button.
    helper.send({ type: 'state', ...state, micAvailable: false });
    await helper.sync();
    assert.equal(probe(['-Action', 'Click', '-Name', 'Mute microphone', '-ProcessId', helper.pid]).clicked, false);
    // Counting down: only Cancel (no pause or mute yet).
    helper.send({ type: 'state', ...state, phase: 'countdown', countdown: 3 });
    await helper.sync();
    assert.equal(probe(['-Action', 'Click', '-Name', 'Pause recording', '-ProcessId', helper.pid]).clicked, false);
    assert.equal(await press('Cancel recording'), 'cancel');
  } finally {
    await helper.close();
  }
});

await test('camera: a circle above the controls, also left out of a screen capture', async () => {
  // A 320×320 JPEG standing in for a camera frame.
  const jpeg = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Drawing; $b = New-Object Drawing.Bitmap 320,320; $g = [Drawing.Graphics]::FromImage($b); $g.Clear([Drawing.Color]::DarkSlateBlue); $m = New-Object IO.MemoryStream; $b.Save($m, [Drawing.Imaging.ImageFormat]::Jpeg); [Convert]::ToBase64String($m.ToArray())',
    ],
    { encoding: 'utf8' },
  ).trim();
  const helper = startHelper(exe);
  try {
    await helper.next((m) => m.type === 'ready');
    helper.send({ type: 'show', ...state });
    await helper.sync();
    const bar = probe(['-Action', 'Capture', '-ProcessId', helper.pid]).rect;
    helper.send({ type: 'camera', frame: jpeg });
    await helper.sync();
    const withCamera = probe(['-Action', 'Capture', '-ProcessId', helper.pid]);
    // Taller by the circle, grown upwards: the bar stays where it was.
    assert.ok(withCamera.rect.height > bar.height * 3, `camera shown: ${JSON.stringify([bar, withCamera.rect])}`);
    assert.ok(Math.abs(withCamera.rect.top + withCamera.rect.height - (bar.top + bar.height)) <= 1, 'bar kept in place');
    assert.ok(withCamera.white > 0.9, `camera left out of the capture: ${JSON.stringify(withCamera)}`);
    // Camera off: back to the bar.
    helper.send({ type: 'camera', frame: null });
    await helper.sync();
    assert.equal(probe(['-Action', 'Capture', '-ProcessId', helper.pid]).rect.height, bar.height);
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
