#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXTENSION_SOURCE = path.join(ROOT, 'extension');
const REPORT_PATH = path.join(ROOT, 'eval/private-data/device-browser-e2e.json');
const BROWSER_APP_PATH = '/Applications/Microsoft Edge.app';
const BROWSER_INFO_PLIST_PATH = path.join(BROWSER_APP_PATH, 'Contents/Info.plist');
const OPEN_PATH = '/usr/bin/open';
const API_TOKEN = randomBytes(32).toString('base64url');
const REQUEST_TIMEOUT_MS = 30_000;
const failures = [];
const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, result: 'PASS' });
    return true;
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    return false;
  }
}

function notRun(name, reason) {
  checks.push({ name, result: 'NOT_RUN', reason });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function findHardwareValue(output, pattern) {
  return output.match(pattern)?.[1]?.trim() || null;
}

function readHardware() {
  const hardwareOutput = run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-detailLevel', 'mini']);
  const displayData = JSON.parse(run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']))
    .SPDisplaysDataType?.[0] || {};
  const metalRaw = displayData.spdisplays_metal;
  const metalSupport = metalRaw === 'spdisplays_supported' ? 'Supported' : metalRaw || null;
  return {
    modelIdentifier: findHardwareValue(hardwareOutput, /Model Identifier: ([^\n]+)/),
    chip: findHardwareValue(hardwareOutput, /Chip: ([^\n]+)/),
    memory: findHardwareValue(hardwareOutput, /Memory: ([^\n]+)/),
    gpuCores: Number(displayData.sppci_cores) || null,
    metal: metalSupport ? !/unsupported|not supported/i.test(metalSupport) : null,
    metalSupport,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function json(response, status, body, origin) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function createApiServer() {
  const metrics = {
    health: 0, transcribe: 0, translate: 0, invalidAuth: 0, preflight: 0,
    corsDenied: [], audioBytes: [], translationInputs: [],
  };
  const transcripts = [
    'Device fixture transcript',
    'Second fixture transcript',
    '<img src=x onerror=alert(1)> Device fixture hostile text',
    'Restart fixture transcript',
  ];
  let extensionOrigin = null;
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    const allowedOrigin = extensionOrigin && origin === extensionOrigin ? extensionOrigin : '';
    const originAllowed = !origin || Boolean(allowedOrigin);
    if (request.method === 'OPTIONS') {
      metrics.preflight += 1;
      if (!allowedOrigin || !/^(GET|POST)$/.test(request.headers['access-control-request-method'] || '')) {
        metrics.corsDenied.push({ method: request.headers['access-control-request-method'] || '', origin });
        response.writeHead(403).end();
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '0',
        Vary: 'Origin',
      }).end();
      return;
    }
    // Extension requests with host permission may omit Origin. Match the Go
    // server contract: bearer auth gates origin-less clients, while browser
    // origins (when present) must exactly match the configured extension.
    if (!originAllowed) {
      metrics.corsDenied.push({ method: request.method, origin });
      response.writeHead(403).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${API_TOKEN}`) {
      metrics.invalidAuth += 1;
      json(response, 401, { error: 'unauthorized' }, allowedOrigin);
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      metrics.health += 1;
      json(response, 200, {
        status: 'ok',
        whisper_model: 'device-fixture-asr',
        llama_model: 'device-fixture-translation',
      }, allowedOrigin);
      return;
    }
    if (request.method === 'POST' && request.url === '/transcribe') {
      const body = await readBody(request);
      metrics.transcribe += 1;
      metrics.audioBytes.push(body.length);
      const hasWav = body.includes(Buffer.from('RIFF')) && body.includes(Buffer.from('WAVE'));
      if (!hasWav || body.length < 1000) {
        json(response, 400, { error: 'expected non-empty captured WAV' }, allowedOrigin);
        return;
      }
      json(response, 200, {
        transcription: transcripts[(metrics.transcribe - 1) % transcripts.length],
        raw_text: transcripts[(metrics.transcribe - 1) % transcripts.length],
        detected_language: 'en',
        backend: 'device-test-double',
        segments: [],
        quality_flags: [],
      }, allowedOrigin);
      return;
    }
    if (request.method === 'POST' && request.url === '/translate') {
      const body = await readBody(request);
      const params = new URLSearchParams(body.toString('utf8'));
      const text = params.get('text') || '';
      metrics.translate += 1;
      metrics.translationInputs.push(text);
      const translation = text === 'Device fixture corrected'
        ? 'Fixture translation for correction'
        : text.startsWith('<img')
          ? '<svg onload=alert(2)> 翻訳fixture'
          : `Fixture translation for: ${text}`;
      json(response, 200, { translation }, allowedOrigin);
      return;
    }
    json(response, 404, { error: 'not found' }, allowedOrigin);
  });
  return {
    server,
    metrics,
    setExtensionOrigin(value) { extensionOrigin = value; },
  };
}

function createMeetFixtureHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Meet Translator isolated device fixture</title>
<style>body{font:16px sans-serif;margin:30px}main{height:500px;background:#253044;color:white;padding:30px}input{width:560px}</style></head>
<body><h1>Local Meet integration fixture</h1><main jscontroller="izfDQc" aria-label="meeting stage">
  <p>Isolated local page standing in for the Meet DOM. No Google account or other participant is used.</p>
  <button id="tone-on">Play synthetic test tone</button> <button id="tone-off">Stop tone</button>
  <label>Meeting chat test field <input id="chat-input" value="private chat sentinel"></label>
  <p id="chat-submits">0</p><button id="share-prompt">Mock share chooser (never calls screen capture)</button>
</main><script>
let context = null; let oscillator = null;
document.querySelector('#tone-on').addEventListener('click', async () => {
  context ||= new AudioContext();
  if (context.state === 'suspended') await context.resume();
  if (oscillator) return;
  oscillator = context.createOscillator(); oscillator.type = 'sine'; oscillator.frequency.value = 440;
  const gain = context.createGain(); gain.gain.value = 0.08;
  oscillator.connect(gain).connect(context.destination); oscillator.start();
});
document.querySelector('#tone-off').addEventListener('click', () => {
  if (oscillator) { oscillator.stop(); oscillator.disconnect(); oscillator = null; }
});
document.querySelector('#chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') document.querySelector('#chat-submits').textContent = String(Number(document.querySelector('#chat-submits').textContent) + 1);
});
</script></body></html>`;
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #networkRequests = new Map();
  networkFailures = [];

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', resolve, { once: true });
      this.#socket.addEventListener('error', reject, { once: true });
    });
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params?.request;
        if (request?.url?.startsWith('http://127.0.0.1:')) {
          this.#networkRequests.set(`${message.sessionId}:${message.params.requestId}`, {
            url: `${new URL(request.url).origin}${new URL(request.url).pathname}`,
            method: request.method,
          });
        }
      } else if (message.method === 'Network.loadingFailed') {
        const key = `${message.sessionId}:${message.params?.requestId}`;
        const request = this.#networkRequests.get(key);
        if (request) {
          this.networkFailures.push({ ...request, errorText: message.params.errorText, blockedReason: message.params.blockedReason || null });
        }
      }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify(message));
    });
  }

  close() { this.#socket.close(); }
}

async function page(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const result = { targetId, sessionId };
  await cdp.send('Runtime.enable', {}, sessionId);
  return result;
}

async function evaluate(cdp, target, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, target.sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page evaluation failed');
  }
  return result.result?.value;
}

async function openTarget(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: false });
  const target = await page(cdp, targetId);
  await waitFor(async () => (await evaluate(cdp, target, 'document.readyState')) === 'complete', `page did not load: ${url}`);
  return target;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function activate(cdp, target) {
  await cdp.send('Target.activateTarget', { targetId: target.targetId });
}

async function click(cdp, target, selector) {
  const point = await evaluate(cdp, target, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center',inline:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  assert.ok(point, `missing clickable element: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, target.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, target.sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, target.sessionId);
}

async function invokeActionShortcut(cdp, target) {
  const events = [
    { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', modifiers: 1 },
    { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 9 },
    { type: 'rawKeyDown', key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers: 9 },
    { type: 'keyUp', key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers: 9 },
    { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 1 },
    { type: 'keyUp', key: 'Alt', code: 'AltLeft', modifiers: 0 },
  ];
  for (const event of events) await cdp.send('Input.dispatchKeyEvent', event, target.sessionId);
}

async function typeInto(cdp, target, selector, value) {
  await click(cdp, target, selector);
  await evaluate(cdp, target, `(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    field.focus();
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function createDevToolsUrl(profile, processHandle) {
  const activePort = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const [port] = (await readFile(activePort, 'utf8')).trim().split('\n');
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch (_) {}
    if (processHandle.exitCode != null) throw new Error(`Edge exited during startup (${processHandle.exitCode})`);
    await delay(100);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function extensionIdFromProfile(profile) {
  for (const relative of ['Default/Preferences', 'Local State']) {
    try {
      const preferences = JSON.parse(await readFile(path.join(profile, relative), 'utf8'));
      const settings = preferences?.extensions?.settings;
      const found = Object.entries(settings || {}).find(([, value]) => value?.manifest?.name === 'Meet Translator');
      if (found) return found[0];
    } catch (_) {}
  }
  return null;
}

function processGroupRssMb(rootPid) {
  try {
    const rows = run('/bin/ps', ['-axo', 'pid=,ppid=,rss=']).split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length >= 3 && row.every(Number.isFinite));
    const parent = new Map(rows.map(([pid, ppid]) => [pid, ppid]));
    const descendants = new Set([Number(rootPid)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows) {
        if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
      }
    }
    const rssKb = rows.reduce((total, [pid, , rss]) => total + (descendants.has(pid) ? rss : 0), 0);
    return Math.round(rssKb / 1024);
  } catch (_) { return null; }
}

export function edgeLaunchArgs(profile, testExtension, startUrl) {
  return [
    '-n', '-g', '-a', BROWSER_APP_PATH, '--args',
    `--user-data-dir=${profile}`,
    `--load-extension=${testExtension}`,
    `--disable-extensions-except=${testExtension}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--ignore-certificate-errors',
    '--host-resolver-rules=MAP meet.google.com 127.0.0.1,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    startUrl,
  ];
}

function findEdgeProcessesForProfile(profile) {
  const profileArgument = `--user-data-dir=${profile}`;
  const rows = run('/bin/ps', ['-axo', 'pid=,command=']).split('\n');
  const processes = [];
  for (const line of rows) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid || !match[2].includes(profileArgument)) continue;
    processes.push({ pid: Number(match[1]), command: match[2] });
  }
  return processes;
}

function findEdgePid(profile) {
  return findEdgeProcessesForProfile(profile).find(({ command }) => !command.includes('--type='))?.pid || null;
}

async function waitForProfileExit(profile, timeoutMs, findProcesses = findEdgeProcessesForProfile) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findProcesses(profile).length === 0) return true;
    await delay(100);
  }
  return findProcesses(profile).length === 0;
}

export async function ensureEdgeProfileExited(profile, {
  findProcesses = findEdgeProcessesForProfile,
  timeoutMs = 5_000,
} = {}) {
  if (await waitForProfileExit(profile, timeoutMs, findProcesses)) return;
  const remaining = findProcesses(profile).map(({ pid }) => pid);
  throw new Error(`Edge processes still use the isolated profile; refusing PID-based termination: ${remaining.join(', ')}`);
}

export async function cleanupIsolatedProfile(profile, scratch, {
  ensureExited = ensureEdgeProfileExited,
  findProcesses = findEdgeProcessesForProfile,
  remove = rm,
} = {}) {
  if (profile) {
    let exitCheckError = null;
    try { await ensureExited(profile); }
    catch (error) { exitCheckError = error.message; }
    let remainingProcesses;
    try { remainingProcesses = findProcesses(profile); }
    catch (error) {
      return {
        retained: Boolean(scratch),
        cleanupError: `Could not confirm isolated Edge processes had exited: ${error.message}`,
      };
    }
    if (remainingProcesses.length > 0) {
      return {
        retained: Boolean(scratch),
        cleanupError: exitCheckError || 'Edge processes still use the isolated profile; temporary profile retained',
      };
    }
  }

  if (scratch) {
    try { await remove(scratch, { recursive: true, force: true }); }
    catch (error) {
      return { retained: true, cleanupError: `Could not remove the isolated temporary profile: ${error.message}` };
    }
  }
  return { retained: false, cleanupError: null };
}

export function edgeProcessHandle(pid, profile, {
  findProcesses = findEdgeProcessesForProfile,
} = {}) {
  return {
    pid,
    get exitCode() {
      try { return findProcesses(profile).some((item) => item.pid === pid) ? null : 1; }
      catch (_) { return null; }
    },
  };
}

async function launchEdge(profile, testExtension, startUrl) {
  const launcher = spawn(OPEN_PATH, edgeLaunchArgs(profile, testExtension, startUrl), { stdio: 'ignore' });
  const exitCode = await new Promise((resolve, reject) => {
    launcher.once('error', reject);
    launcher.once('exit', resolve);
  });
  if (exitCode !== 0) {
    await ensureEdgeProfileExited(profile);
    throw new Error(`Launch Services failed to start the isolated Edge instance (exit ${exitCode})`);
  }

  return waitForEdgeProcess(profile).then((pid) => edgeProcessHandle(pid, profile));
}

export async function waitForEdgeProcess(profile, {
  findPid = findEdgePid,
  cleanup = ensureEdgeProfileExited,
  attempts = 100,
  pollIntervalMs = 100,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pid = findPid(profile);
    if (pid) return pid;
    await delay(pollIntervalMs);
  }
  try {
    await cleanup(profile);
  } catch (cleanupError) {
    throw new Error(
      `Launch Services returned without starting the isolated Edge process; profile cleanup failed: ${cleanupError.message}`,
      { cause: cleanupError },
    );
  }
  throw new Error('Launch Services returned without starting the isolated Edge process');
}

export function edgeVersionReadCommand() {
  return {
    command: '/usr/bin/plutil',
    args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', BROWSER_INFO_PLIST_PATH],
  };
}

function readEdgeVersion() {
  const { command, args } = edgeVersionReadCommand();
  return run(command, args);
}

async function main() {
  assert.equal(process.platform, 'darwin', 'real-device browser suite currently supports macOS only');
  assert.equal(process.arch, 'arm64', 'real-device browser suite requires Apple Silicon');
  const hardware = readHardware();
  assert.match(hardware.chip || '', /M1 Max/, 'required Apple M1 Max hardware was not detected');
  assert.match(hardware.memory || '', /^32 GB$/, 'required 32 GB unified memory was not detected');
  assert.equal(hardware.gpuCores, 24, 'required 24-core GPU was not detected');

  const browserVersion = readEdgeVersion();
  let scratch = null;
  let profile = null;
  let api = null;
  let meetServer = null;
  let chromeProcess;
  let cdp;
  let cleanupError = null;
  let chromeRssBefore = null;
  let chromeRssAfter = null;
  const startedAt = new Date().toISOString();
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'meet-translator-device-'));
    profile = path.join(scratch, 'chrome-profile');
    const testExtension = path.join(scratch, 'extension');
    const certDir = path.join(scratch, 'tls');
    const extensionKeyPath = path.join(scratch, 'extension-private.pem');
    const extensionPublicKeyPath = path.join(scratch, 'extension-public.der');
    await mkdir(profile, { recursive: true });
    await mkdir(testExtension, { recursive: true });
    await mkdir(certDir, { recursive: true });
    await import('node:fs/promises').then(({ cp }) => cp(EXTENSION_SOURCE, testExtension, { recursive: true }));
    run('/opt/homebrew/bin/openssl', ['genrsa', '-out', extensionKeyPath, '2048']);
    run('/opt/homebrew/bin/openssl', ['rsa', '-in', extensionKeyPath, '-pubout', '-outform', 'DER', '-out', extensionPublicKeyPath]);
    const extensionPublicKey = (await readFile(extensionPublicKeyPath)).toString('base64');
    const extensionId = createHash('sha256').update(await readFile(extensionPublicKeyPath)).digest().subarray(0, 16)
      .toString('hex').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
    const manifestPath = path.join(testExtension, 'manifest.json');
    const testManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    testManifest.key = extensionPublicKey;
    testManifest.commands = {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+Y', mac: 'Alt+Shift+Y' },
        description: 'Invoke the extension in the isolated device test',
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(testManifest, null, 2)}\n`);
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    run('/opt/homebrew/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes', '-subj', '/CN=meet.google.com', '-addext', 'subjectAltName=DNS:meet.google.com',
    ]);

    api = createApiServer();
    const apiPort = await listen(api.server);
    meetServer = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_request, response) => {
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' });
      response.end(createMeetFixtureHtml());
    });
    const meetPort = await listen(meetServer);
    chromeProcess = await launchEdge(profile, testExtension, `https://meet.google.com:${meetPort}/device-fixture`);
    const cdpUrl = await createDevToolsUrl(profile, chromeProcess);
    cdp = new Cdp(cdpUrl);
    let registered = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const targets = (await cdp.send('Target.getTargets')).targetInfos;
      if (targets.some((item) => item.url.startsWith(`chrome-extension://${extensionId}/`))) { registered = true; break; }
      await delay(100);
    }
    if (!registered) {
      const manager = await openTarget(cdp, 'chrome://extensions');
      const extensionPage = await evaluate(cdp, manager, `(() => {
        const parts=[]; const visited=new Set();
        const walk=root=>{ if(!root||visited.has(root)) return; visited.add(root); if(root.innerText) parts.push(root.innerText.slice(0,500)); for(const el of root.querySelectorAll?.('*')||[]) if(el.shadowRoot) walk(el.shadowRoot); };
        walk(document); return parts.join('\\n---shadow---\\n').slice(0,3000);
      })()`);
      const versionPage = await openTarget(cdp, 'chrome://version');
      const commandLine = await evaluate(cdp, versionPage, 'document.querySelector("#command_line")?.innerText || ""');
      let profileFiles = [];
      try { profileFiles = await import('node:fs/promises').then(({ readdir }) => readdir(profile)); } catch (_) {}
      throw new Error(`Chrome did not load the unpacked test extension: ${JSON.stringify({ extensionId, extensionPage, commandLine, profileFiles })}`);
    }
    api.setExtensionOrigin(`chrome-extension://${extensionId}`);

    const options = await openTarget(cdp, `chrome-extension://${extensionId}/options.html`);
    const optionsContext = await evaluate(cdp, options, `({href:location.href,title:document.title,runtime:typeof chrome?.runtime,body:document.body?.innerText?.slice(0,400)||''})`);
    if (optionsContext.runtime !== 'object') {
      const preferences = JSON.parse(await readFile(path.join(profile, 'Default/Preferences'), 'utf8'));
      const registration = preferences?.extensions?.settings?.[extensionId];
      throw new Error(`extension options page did not run in its origin: ${JSON.stringify({
        page: optionsContext,
        extensionId,
        registeredPath: registration?.path || null,
        state: registration?.state ?? null,
        manifestVersion: registration?.manifest?.manifest_version ?? null,
        sourceOptionsExists: (await readFile(path.join(testExtension, 'options.html'))).length > 0,
      })}`);
    }
    const wakeResult = await evaluate(cdp, options, `new Promise(resolve=>chrome.runtime.sendMessage({type:'GET_STATE'}, value=>resolve({value:value||null,error:chrome.runtime.lastError?.message||null})))`);
    assert.equal(wakeResult.error, null, `service worker could not answer a real extension message: ${wakeResult.error}`);
    await waitFor(async () => {
      const targets = (await cdp.send('Target.getTargets')).targetInfos;
      return targets.some((item) => item.type === 'service_worker' && item.url === `chrome-extension://${extensionId}/background.js`);
    }, 'extension service worker to activate');

    const meetInfo = (await cdp.send('Target.getTargets')).targetInfos.find((item) => item.url.startsWith(`https://meet.google.com:${meetPort}/`));
    assert.ok(meetInfo, 'local Meet fixture tab was not created');
    const meet = await page(cdp, meetInfo.targetId);
    await waitFor(async () => (await evaluate(cdp, meet, 'document.querySelector("main[jscontroller=izfDQc]") !== null')) === true, 'Meet content-script fixture to load');
    await waitFor(async () => (await evaluate(cdp, meet, 'document.title')).includes('isolated device fixture'), 'local Meet page');

    const extensionBase = `chrome-extension://${extensionId}`;
    await waitFor(async () => await evaluate(cdp, options, `({
      serverUrl: document.querySelector('#server-url').value,
      audioSource: document.querySelector('#audio-source').value,
      extensionOrigin: document.querySelector('#extension-origin').textContent,
    })`).then((state) => state.serverUrl === 'http://127.0.0.1:17070' &&
      state.audioSource === 'mic-only' && state.extensionOrigin === extensionBase), 'extension options to finish loading');
    await evaluate(cdp, options, `(() => {
      document.querySelector('#server-url').value=${JSON.stringify(`http://127.0.0.1:${apiPort}`)};
      document.querySelector('#api-token').value=${JSON.stringify(API_TOKEN)};
      document.querySelector('#source-lang').value='en';
      document.querySelector('#target-lang').value='ja';
      document.querySelector('#audio-source').value='tab-only';
      document.querySelector('#overlay-enabled').checked=true;
      document.querySelector('#overlay-format').value='both';
      document.querySelector('#source-lang').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#overlay-enabled').dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    const savedSettings = {
      serverUrl: `http://127.0.0.1:${apiPort}`,
      apiToken: API_TOKEN,
      sourceLang: 'en',
      targetLang: 'ja',
      audioSource: 'tab-only',
      overlayEnabled: true,
      overlayFormat: 'both',
    };
    await evaluate(cdp, options, `(() => {
      window.__deviceSaveButtonClicks = 0;
      document.querySelector('#save-btn').addEventListener('click', () => window.__deviceSaveButtonClicks++);
    })()`);
    await activate(cdp, options);
    const settingsSavedInUi = await check('settings page saves test configuration through its button', async () => {
      await click(cdp, options, '#save-btn');
      await waitFor(async () => {
        const saved = await evaluate(cdp, options, `new Promise(resolve=>chrome.storage.local.get(${JSON.stringify(Object.keys(savedSettings))},resolve))`);
        return Object.entries(savedSettings).every(([key, value]) => saved[key] === value);
      }, 'extension settings to persist', 5_000);
    });
    if (!settingsSavedInUi) {
      const diagnostic = await evaluate(cdp, options, `new Promise(resolve=>chrome.storage.local.get(${JSON.stringify(Object.keys(savedSettings))},stored=>resolve({
        form: {
          serverUrl: document.querySelector('#server-url').value,
          apiTokenSet: Boolean(document.querySelector('#api-token').value),
          sourceLang: document.querySelector('#source-lang').value,
          targetLang: document.querySelector('#target-lang').value,
          audioSource: document.querySelector('#audio-source').value,
          overlayEnabled: document.querySelector('#overlay-enabled').checked,
          overlayFormat: document.querySelector('#overlay-format').value,
        },
        stored: { ...stored, apiToken: stored.apiToken ? '[set]' : '' },
        saveButtonClicks: window.__deviceSaveButtonClicks,
        saveButtonDisabled: document.querySelector('#save-btn').disabled,
        status: document.querySelector('#status-msg').textContent,
        statusClass: document.querySelector('#status-msg').className,
      })))`);
      failures[failures.length - 1].message += `; diagnostic=${JSON.stringify(diagnostic)}`;
      await evaluate(cdp, options, `new Promise(resolve=>chrome.storage.local.set(${JSON.stringify(savedSettings)},resolve))`);
      await waitFor(async () => {
        const stored = await evaluate(cdp, options, `new Promise(resolve=>chrome.storage.local.get(${JSON.stringify(Object.keys(savedSettings))},resolve))`);
        return Object.entries(savedSettings).every(([key, value]) => stored[key] === value);
      }, 'test configuration to seed extension storage');
    }

    const popup = await openTarget(cdp, `${extensionBase}/popup.html`);
    await activate(cdp, meet);
    await click(cdp, popup, '#open-correction-panel');
    await check('Edge opens the correction UI in its native extension side panel', async () => {
      await waitFor(async () => {
        const targets = (await cdp.send('Target.getTargets')).targetInfos;
        return targets.some((item) => item.url === `${extensionBase}/sidepanel.html`);
      }, 'Edge extension side panel to open');
    });
    const sidepanelInfo = (await cdp.send('Target.getTargets')).targetInfos.find((item) => item.url === `${extensionBase}/sidepanel.html`);
    const sidepanel = await page(cdp, sidepanelInfo.targetId);
    const presenter = await openTarget(cdp, `${extensionBase}/caption-presenter.html`);
    chromeRssBefore = processGroupRssMb(chromeProcess.pid);

    await check('options and local API authentication', async () => {
      await cdp.send('Network.enable', {}, options.sessionId);
      await evaluate(cdp, options, `(() => {
        window.__deviceHealthButtonClicks = 0;
        document.querySelector('#health-btn').addEventListener('click', () => window.__deviceHealthButtonClicks++);
      })()`);
      await activate(cdp, options);
      await click(cdp, options, '#health-btn');
      try {
        await waitFor(async () => api.metrics.health > 0 &&
          await evaluate(cdp, options, 'document.querySelector("#status-msg").className') === 'ok',
        'authenticated local API health result in the settings UI', 5_000);
      } catch (error) {
        const diagnostic = await evaluate(cdp, options, `({
          clicks: window.__deviceHealthButtonClicks,
          url: document.querySelector('#server-url').value,
          tokenSet: Boolean(document.querySelector('#api-token').value),
          extensionOrigin: document.querySelector('#extension-origin').textContent,
          status: document.querySelector('#status-msg').textContent,
          statusClass: document.querySelector('#status-msg').className,
        })`);
        throw new Error(`${error.message}; diagnostic=${JSON.stringify({ page: diagnostic, api: api.metrics, networkFailures: cdp.networkFailures })}`);
      }
      assert.ok(api.metrics.health > 0, `local API request rejected by CORS: ${JSON.stringify(api.metrics.corsDenied)}`);
      assert.equal(api.metrics.invalidAuth, 0);
    });

    await check('private side panel and public caption page initialize in real Edge', async () => {
      assert.equal(await evaluate(cdp, sidepanel, 'document.querySelectorAll(".history-item").length'), 0);
      assert.match(await evaluate(cdp, presenter, 'document.querySelector("#empty-state").textContent'), /待っています/);
      assert.equal(await evaluate(cdp, meet, 'document.querySelector("#meet-translator-overlay")'), null);
    });

    await cdp.send('Target.closeTarget', { targetId: popup.targetId });
    await activate(cdp, meet);
    await invokeActionShortcut(cdp, meet);
    let actionPopupInfo;
    await waitFor(async () => {
      const targets = (await cdp.send('Target.getTargets')).targetInfos;
      actionPopupInfo = targets.find((item) => item.url === `${extensionBase}/popup.html`) || null;
      return actionPopupInfo;
    }, 'real Edge extension action invocation through the test-only keyboard shortcut', 5_000);
    const actionPopup = await page(cdp, actionPopupInfo.targetId);
    const getActionPopup = async () => {
      let targetInfo = (await cdp.send('Target.getTargets')).targetInfos
        .find((item) => item.url === `${extensionBase}/popup.html`);
      if (!targetInfo) {
        await activate(cdp, meet);
        await invokeActionShortcut(cdp, meet);
        await waitFor(async () => {
          targetInfo = (await cdp.send('Target.getTargets')).targetInfos
            .find((item) => item.url === `${extensionBase}/popup.html`);
          return targetInfo;
        }, 'Edge extension action popup to reopen', 5_000);
      }
      return page(cdp, targetInfo.targetId);
    };

    const captureStarted = await check('popup starts tab audio capture on the isolated Meet origin', async () => {
      await click(cdp, actionPopup, '#toggle-btn');
      try {
        await waitFor(async () => (await evaluate(cdp, actionPopup, 'document.querySelector("#toggle-btn").classList.contains("stop")')) === true, 'popup start response', 5_000);
      } catch (error) {
        const diagnostic = await evaluate(cdp, actionPopup, `new Promise(resolve=>chrome.tabs.query({active:true,currentWindow:true},tabs=>chrome.runtime.sendMessage({type:'GET_STATE'},state=>resolve({
          buttonText: document.querySelector('#toggle-btn').textContent,
          buttonDisabled: document.querySelector('#toggle-btn').disabled,
          error: document.querySelector('#error-msg').textContent,
          activeTab: tabs?.[0] ? {id:tabs[0].id,url:tabs[0].url} : null,
          state: state || null,
          runtimeError: chrome.runtime.lastError?.message || null,
        }))))`);
        throw new Error(`${error.message}; diagnostic=${JSON.stringify(diagnostic)}`);
      }
      const state = await evaluate(cdp, actionPopup, `new Promise(resolve=>chrome.runtime.sendMessage({type:'GET_STATE'},resolve))`);
      assert.equal(state.isActive, true);
      assert.equal(await evaluate(cdp, meet, 'document.querySelector("#meet-translator-overlay")'), null,
        'the Meet overlay must remain hidden before an explicitly approved caption exists');
    });

    const playTone = async () => {
      await activate(cdp, meet);
      await click(cdp, meet, '#tone-on');
      await delay(1_600);
      await click(cdp, meet, '#tone-off');
      await delay(1_500);
    };

    if (captureStarted) {
      const candidateReceived = await check('captured tab audio reaches the local ASR transport and private review UI', async () => {
        const chatStateBefore = await evaluate(cdp, meet, `(() => { const el=document.querySelector('#chat-input'); el.focus(); el.setSelectionRange(3,8); return {value:el.value,start:el.selectionStart,end:el.selectionEnd,submits:document.querySelector('#chat-submits').textContent}; })()`);
        await playTone();
        await waitFor(() => api.metrics.transcribe >= 1, 'captured WAV to reach local transcription endpoint');
        await waitFor(async () => (await evaluate(cdp, sidepanel, 'document.querySelectorAll(".history-item").length')) >= 1, 'private candidate');
        assert.equal(await evaluate(cdp, sidepanel, 'document.querySelector(".history-item span")?.textContent'), 'Device fixture transcript');
        await waitFor(() => api.metrics.translate >= 1, 'local translation request');
        assert.ok(api.metrics.audioBytes[0] > 1000, 'captured audio body was unexpectedly small');
        const publicBeforeApproval = await evaluate(cdp, presenter, 'document.body.innerText');
        assert.equal(publicBeforeApproval.includes('Device fixture transcript'), false, 'unapproved candidate leaked to public caption page');
        const chatStateAfter = await evaluate(cdp, meet, `(() => { const el=document.querySelector('#chat-input'); return {value:el.value,start:el.selectionStart,end:el.selectionEnd,submits:document.querySelector('#chat-submits').textContent}; })()`);
        assert.deepEqual(chatStateAfter, chatStateBefore, 'extension changed chat text, selection, or submit state');
        assert.equal(await evaluate(cdp, meet, 'document.querySelector("#meet-translator-overlay")'), null, 'unapproved candidate appeared on Meet overlay');
      });

      if (candidateReceived) {
        await check('correction draft and selected text survive a new audio result', async () => {
          await activate(cdp, sidepanel);
          await click(cdp, sidepanel, '.history-item');
          await typeInto(cdp, sidepanel, '#source-text', 'Device fixture corrected');
          await evaluate(cdp, sidepanel, 'document.querySelector("#source-text").setSelectionRange(2,8)');
          await playTone();
          await waitFor(async () => (await evaluate(cdp, sidepanel, 'document.querySelectorAll(".history-item").length')) >= 2, 'second candidate while correction draft is open');
          const editor = await evaluate(cdp, sidepanel, `(() => { const el=document.querySelector('#source-text'); return {value:el.value,start:el.selectionStart,end:el.selectionEnd,active:document.activeElement===el,selected:document.querySelector('.history-item[aria-pressed="true"] span')?.textContent}; })()`);
          assert.deepEqual(editor, { value: 'Device fixture corrected', start: 2, end: 8, active: true, selected: 'Device fixture transcript' });
        });

        await check('correction retranslates the new source revision and undo restores the prior revision', async () => {
          await activate(cdp, sidepanel);
          await click(cdp, sidepanel, '#save-correction');
          await waitFor(() => api.metrics.translate >= 2, 'corrected translation request');
          await waitFor(async () => (await evaluate(cdp, sidepanel, 'document.querySelector("#translation").textContent')).includes('Fixture translation for correction'), 'corrected translation visible to host');
          assert.equal(await evaluate(cdp, presenter, 'document.body.innerText.includes("Device fixture corrected")'), false, 'edited text became public before approval');
          await click(cdp, sidepanel, '#undo-correction');
          await waitFor(async () => (await evaluate(cdp, sidepanel, 'document.querySelector("#source-text").value')).includes('Device fixture transcript'), 'undo restored source text');
          assert.match(await evaluate(cdp, sidepanel, 'document.querySelector("#translation").textContent'), /Fixture translation for: Device fixture transcript/);
          assert.equal(await evaluate(cdp, presenter, 'document.body.innerText.includes("Device fixture transcript")'), false, 'undo accidentally published source text');
        });

        await check('explicit approval publishes only the approved source and current translation', async () => {
          await click(cdp, sidepanel, '#approve-caption');
          await waitFor(async () => (await evaluate(cdp, presenter, 'document.body.innerText')).includes('Device fixture transcript'), 'approved public caption');
          const publicPageText = await evaluate(cdp, presenter, 'document.body.innerText');
          assert.match(publicPageText, /Fixture translation for: Device fixture transcript/);
          assert.equal(publicPageText.includes('INSUFFICIENT_EVIDENCE'), false);
          assert.equal(publicPageText.includes('device-fixture-asr'), false);
          await waitFor(async () => (await evaluate(cdp, meet, 'document.querySelector("#mt-subtitle-panel")?.innerText || ""')).includes('Fixture translation for: Device fixture transcript'), 'Meet overlay receives approved caption');
          const hostileNodes = await evaluate(cdp, presenter, 'document.querySelector("#caption-list").querySelectorAll("img,svg,script").length');
          assert.equal(hostileNodes, 0, 'caption output created executable markup');
        });

        await check('hostile-looking fixture text renders as text in the public page', async () => {
          await playTone();
          await waitFor(async () => (await evaluate(cdp, sidepanel, 'document.querySelectorAll(".history-item").length')) >= 3, 'hostile text candidate');
          assert.ok(await evaluate(cdp, sidepanel, 'document.querySelectorAll("img").length') === 0);
          const third = await evaluate(cdp, sidepanel, 'document.querySelectorAll(".history-item")[2]?.children[0]?.textContent');
          assert.match(third, /<img src=x onerror=alert\(1\)>/);
          assert.equal(await evaluate(cdp, presenter, 'document.querySelectorAll("img,svg").length'), 0);
          await click(cdp, sidepanel, '.history-item:nth-of-type(3)');
          await click(cdp, sidepanel, '#approve-caption');
          await waitFor(async () => (await evaluate(cdp, presenter, 'document.body.innerText')).includes('Device fixture hostile text'), 'hostile text approved as plain caption');
          assert.equal(await evaluate(cdp, presenter, 'document.querySelectorAll("img,svg").length'), 0);
        });
      } else {
        notRun('correction draft, correction/undo, approval, and hostile-text checks', 'no private candidate arrived');
      }

      await check('stop clears the active Meet overlay and public session', async () => {
        const currentPopup = await getActionPopup();
        await click(cdp, currentPopup, '#toggle-btn');
        await waitFor(async () => (await evaluate(cdp, currentPopup, 'document.querySelector("#toggle-btn").classList.contains("stop")')) === false, 'popup stop response');
        await waitFor(async () => (await evaluate(cdp, meet, 'document.querySelector("#meet-translator-overlay")')) === null, 'Meet overlay cleanup');
        await waitFor(async () => (await evaluate(cdp, presenter, 'document.querySelector("#empty-state").textContent')).includes('終了'), 'public session end');
      });

      await check('restart lifecycle works and silence does not request transcription', async () => {
        const restartPopup = await getActionPopup();
        await click(cdp, restartPopup, '#toggle-btn');
        await waitFor(async () => (await evaluate(cdp, restartPopup, 'document.querySelector("#toggle-btn").classList.contains("stop")')) === true, 'popup restart response');
        const requestsBeforeSilence = api.metrics.transcribe;
        await delay(1_500);
        assert.equal(api.metrics.transcribe, requestsBeforeSilence, 'silence triggered an ASR request');
        await playTone();
        await waitFor(() => api.metrics.transcribe > requestsBeforeSilence, 'audio after restart');
        const secondStopPopup = await getActionPopup();
        await click(cdp, secondStopPopup, '#toggle-btn');
        await waitFor(async () => (await evaluate(cdp, secondStopPopup, 'document.querySelector("#toggle-btn").classList.contains("stop")')) === false, 'popup second stop response');
      });
    } else {
      notRun('tab audio, private correction, approval, stop, and restart integration checks', 'capture did not start');
    }

    chromeRssAfter = processGroupRssMb(chromeProcess.pid);
    await check('local API received only authenticated synthetic requests', async () => {
      assert.equal(api.metrics.invalidAuth, 0);
      if (captureStarted) {
        assert.ok(api.metrics.health >= 1);
        assert.ok(api.metrics.transcribe >= 4);
        assert.ok(api.metrics.translate >= 3);
        assert.ok(api.metrics.translationInputs.includes('Device fixture corrected'));
      }
    });
  } catch (error) {
    if (!failures.some((failure) => failure.message === (error?.message || String(error)))) {
      failures.push({ name: 'browser suite orchestration', message: error?.message || String(error) });
    }
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (_) {}
    try {
      if (api?.server?.listening) await new Promise((resolve, reject) => api.server.close((error) => error ? reject(error) : resolve()));
    } catch (error) { cleanupError = error.message; }
    try {
      if (meetServer?.listening) await new Promise((resolve, reject) => meetServer.close((error) => error ? reject(error) : resolve()));
    } catch (error) { cleanupError ||= error.message; }
    if (cdp) cdp.close();
    const profileCleanup = await cleanupIsolatedProfile(profile, scratch);
    cleanupError = [cleanupError, profileCleanup.cleanupError].filter(Boolean).join('; ') || null;
    if (profileCleanup.retained) failures.push({ name: 'browser profile cleanup', message: profileCleanup.cleanupError });
  }

  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    result: failures.length ? 'FAIL' : 'PASS',
    scope: 'Real Microsoft Edge MV3 extension + isolated local Meet DOM + synthetic tab tone + local deterministic API test double',
    hardware: {
      modelIdentifier: hardware.modelIdentifier,
      chip: hardware.chip,
      memory: hardware.memory,
      gpuCores: hardware.gpuCores,
      metal: hardware.metal,
      metalSupport: hardware.metalSupport,
      architecture: process.arch,
      macOS: run('/usr/bin/sw_vers', ['-productVersion']),
    browser: 'Microsoft Edge',
    browserVersion,
      edgeProcessTreeRssBeforeMiB: chromeRssBefore,
      edgeProcessTreeRssAfterMiB: chromeRssAfter,
    },
    modelQualification: 'NOT_RUN: no authorized evaluation corpus or model weights; this run does not measure ASR/translation quality, model latency, Metal execution, or inference memory',
    apiMetrics: api?.metrics || null,
    checks,
    failures,
    cleanupError,
  };
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
