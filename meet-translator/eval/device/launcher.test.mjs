import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupIsolatedProfile,
  edgeProcessHandle,
  edgeLaunchArgs,
  edgeVersionReadCommand,
  ensureEdgeProfileExited,
  waitForEdgeProcess,
} from './run-browser-e2e.mjs';

test('Edge process observation handles cannot signal a possibly reused PID', () => {
  const browser = edgeProcessHandle(81300, '/private/tmp/meet-translator-device/profile', {
    findProcesses: () => [],
  });

  assert.equal(browser.pid, 81300);
  assert.equal(browser.exitCode, 1, 'a PID without the isolated profile is no longer the Edge process');
  assert.equal('kill' in browser, false);
});

test('Edge device runs use a new background Launch Services instance with an isolated profile', () => {
  const args = edgeLaunchArgs('/private/tmp/meet-translator-device/profile', '/private/tmp/meet-translator-device/extension', 'https://meet.google.com:12345/device-fixture');

  assert.deepEqual(args.slice(0, 5), [
    '-n', '-g', '-a', '/Applications/Microsoft Edge.app', '--args',
  ]);
  assert.ok(args.includes('--user-data-dir=/private/tmp/meet-translator-device/profile'));
  assert.ok(args.includes('--load-extension=/private/tmp/meet-translator-device/extension'));
  assert.equal(args.at(-1), 'https://meet.google.com:12345/device-fixture');
  assert.equal(args.some((argument) => argument.includes('/Contents/MacOS/Microsoft Edge')), false);
});

test('Edge version metadata is read without executing the browser binary', () => {
  const { command, args } = edgeVersionReadCommand();

  assert.equal(command, '/usr/bin/plutil');
  assert.deepEqual(args.slice(0, 5), [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
  ]);
  assert.equal(args.at(-1), '/Applications/Microsoft Edge.app/Contents/Info.plist');
  assert.equal(args.some((argument) => argument.includes('/Contents/MacOS/Microsoft Edge')), false);
});

test('Launch Services startup timeout verifies the isolated profile can be cleaned up', async () => {
  const profile = '/private/tmp/meet-translator-device/profile';
  const cleanedProfiles = [];

  await assert.rejects(waitForEdgeProcess(profile, {
    findPid: () => null,
    cleanup: async (requestedProfile) => cleanedProfiles.push(requestedProfile),
    attempts: 2,
    pollIntervalMs: 0,
  }), /Launch Services returned without starting the isolated Edge process/);

  assert.deepEqual(cleanedProfiles, [profile]);
});

test('isolated profile is retained instead of signaling a process that may outlive its root', async () => {
  const profile = '/private/tmp/meet-translator-device/profile';
  const scratch = '/private/tmp/meet-translator-device';
  const process = { pid: 81300, command: `Microsoft Edge --type=utility --user-data-dir=${profile}` };
  let removed = false;
  const result = await cleanupIsolatedProfile(profile, scratch, {
    ensureExited: (requestedProfile) => ensureEdgeProfileExited(requestedProfile, {
      findProcesses: () => [process],
      timeoutMs: 0,
    }),
    findProcesses: () => [process],
    remove: async () => { removed = true; },
  });

  assert.equal(removed, false);
  assert.equal(result.retained, true);
  assert.match(result.cleanupError, /refusing PID-based termination/);
});

test('temporary profile is preserved if an Edge helper remains after the root process exits', async () => {
  const profile = '/private/tmp/meet-translator-device/profile';
  let stoppedProfile = null;
  let removed = false;
  const result = await cleanupIsolatedProfile(
    profile,
    '/private/tmp/meet-translator-device',
    {
      ensureExited: async (requestedProfile) => { stoppedProfile = requestedProfile; },
      findProcesses: () => [{ pid: 81300, command: `Microsoft Edge --type=utility --user-data-dir=${profile}` }],
      remove: async () => { removed = true; },
    },
  );

  assert.equal(stoppedProfile, profile);
  assert.equal(removed, false);
  assert.equal(result.retained, true);
  assert.match(result.cleanupError, /still use the isolated profile/);
});

test('temporary profile is preserved when Edge process exit cannot be confirmed', async () => {
  let removed = false;
  const result = await cleanupIsolatedProfile(
    '/private/tmp/meet-translator-device/profile',
    '/private/tmp/meet-translator-device',
    {
      ensureExited: async () => {},
      findProcesses: () => { throw new Error('process listing unavailable'); },
      remove: async () => { removed = true; },
    },
  );

  assert.equal(removed, false);
  assert.equal(result.retained, true);
  assert.match(result.cleanupError, /Could not confirm isolated Edge processes had exited/);
});
