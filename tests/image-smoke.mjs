import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Bound failures in MCP startup, browser launch, and gateway shutdown as well as
// individual commands. Exiting PID 1's child ends the container and its workers.
setTimeout(() => {
  console.error('Image smoke test exceeded its three-minute deadline');
  process.exit(1);
}, 180000).unref();

const role = process.env.TEST_IMAGE_ROLE;
assert(['gateway', 'sandbox'].includes(role));
assert.equal(process.getuid(), 1000);
assert.equal(process.env.TICKTICK_API_TOKEN, undefined);
const configPath = process.env.MCPORTER_CONFIG;
assert.equal(configPath, '/etc/mcporter/mcporter.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const names = role === 'gateway' ? ['ticktick'] : ['playwright', 'ticktick'];

function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? '/tmp',
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const cli = (args, options) => command('mcporter', args, options);

// Exercise the runtime links in a login shell too: mounted homes and read-only
// roots must not trigger mise installs, shim regeneration, or npm cache writes.
const tools = await command('bash', ['-lc',
  'node --version && npm --version && python --version && uv --version && uvx --version',
]);
assert.equal(tools.code, 0, tools.stdout + tools.stderr);
console.log(`${role} runtime tools:\n${tools.stdout.trim()}`);

if (role === 'gateway') {
  for (const program of ['openclaw', 'docker']) {
    const result = await command(program, ['--version']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    console.log(result.stdout.trim());
  }

  // Start a fresh, account-free gateway and check the same endpoint as Compose.
  // No Docker socket or provider keys are needed for startup and local health.
  const gateway = spawn('openclaw', [
    'gateway', '--allow-unconfigured', '--bind', 'loopback', '--port', '18789',
  ], {
    env: { ...process.env, OPENCLAW_STATE_DIR: '/tmp/openclaw-smoke',
      OPENCLAW_CONFIG_PATH: '/tmp/openclaw-smoke/openclaw.json',
      OPENCLAW_GATEWAY_TOKEN: 'openclaw-smoke-fixture-gateway-token' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let startupError;
  gateway.stdout.on('data', chunk => { output += chunk; });
  gateway.stderr.on('data', chunk => { output += chunk; });
  gateway.on('error', error => { startupError = error; });
  const closed = new Promise(resolve => gateway.once('close', resolve));
  try {
    let healthy = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      assert(!startupError, String(startupError));
      assert.equal(gateway.exitCode, null, output);
      assert.equal(gateway.signalCode, null, output);
      try {
        const response = await fetch('http://127.0.0.1:18789/healthz', {
          signal: AbortSignal.timeout(2000),
        });
        await response.text();
        healthy = response.ok;
      } catch { /* The gateway may still be starting. */ }
      if (healthy) break;
      await delay(250);
    }
    assert(healthy, `Gateway did not become healthy:\n${output}`);
    console.log('PASS gateway: OpenClaw starts and /healthz responds');
  } finally {
    const stop = signal => {
      if (!gateway.pid) return;
      try { process.kill(-gateway.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    stop('SIGTERM');
    const killTimer = setTimeout(() => stop('SIGKILL'), 5000);
    await closed;
    clearTimeout(killTimer);
  }
}

// A workspace config must not shadow the explicitly selected image defaults.
await mkdir('/workspace/config', { recursive: true });
await writeFile('/workspace/config/mcporter.json', JSON.stringify({
  mcpServers: { unexpected: { baseUrl: 'http://127.0.0.1:1' } }, imports: [],
}));
for (const cwd of ['/tmp', '/workspace', process.env.HOME]) {
  const result = await cli(['config', 'list', '--json'], { cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).servers.map(server => server.name).sort(), names);
}
const token = 'openclaw-smoke-fixture-token';
const inspect = await cli(['config', 'get', 'ticktick', '--json'], {
  env: { TICKTICK_API_TOKEN: token },
});
assert.equal(inspect.code, 0, inspect.stderr);
assert(inspect.stdout.includes('${TICKTICK_API_TOKEN}'));
assert(!inspect.stdout.includes(token), 'Config inspection exposed the resolved token');
assert.equal(config.mcpServers.ticktick.baseUrl, 'https://mcp.ticktick.com');

let requests = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/page') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<title>MCP config smoke</title><h1>Configured browser works</h1>');
    return;
  }
  requests += 1;
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'auth-fixture', version: '1.0.0' } }
    : { tools: [{ name: 'auth_probe', description: 'Tests bearer authentication',
        inputSchema: { type: 'object', properties: {} } }] };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
  const override = structuredClone(config);
  override.mcpServers.ticktick.baseUrl = fixtureUrl;
  const overridePath = '/tmp/mcporter-override.json';
  await writeFile(overridePath, JSON.stringify(override));
  const selected = await cli(['--config', overridePath, 'config', 'get', 'ticktick', '--json']);
  assert.equal(selected.code, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).baseUrl, `${fixtureUrl}/`);
  const args = ['list', 'ticktick', '--json', '--no-oauth', '--exit-code', '--timeout', '5000'];
  const missing = await cli(['--config', overridePath, ...args]);
  assert.notEqual(missing.code, 0);
  assert((missing.stdout + missing.stderr).includes('TICKTICK_API_TOKEN'));
  assert.equal(requests, 0, 'A missing token caused a network request');
  const authenticated = await cli(args, {
    env: { MCPORTER_CONFIG: overridePath, TICKTICK_API_TOKEN: token },
  });
  assert.equal(authenticated.code, 0, authenticated.stdout + authenticated.stderr);
  assert(authenticated.stdout.includes('auth_probe'));
  assert(requests > 0, 'The configured bearer token never reached the fixture');

  if (role === 'sandbox') {
    // Use the installed runtime's normal config loader, including its stdio cwd.
    const { createRuntime } = await import('/usr/local/lib/node_modules/mcporter/dist/index.js');
    const runtime = await createRuntime();
    try {
      const navigation = await runtime.callTool('playwright', 'browser_navigate', {
        args: { url: `${fixtureUrl}/page` },
      });
      assert(!navigation.isError, JSON.stringify(navigation));
      assert(JSON.stringify(navigation).includes('MCP config smoke'));
      const screenshot = await runtime.callTool('playwright', 'browser_take_screenshot', {
        args: { type: 'png', filename: 'config-smoke.png' },
      });
      assert(!screenshot.isError, JSON.stringify(screenshot));
      assert((await stat('/workspace/config-smoke.png')).size > 0);
      console.log('PASS sandbox: configured Playwright MCP navigates and saves a screenshot');
    } finally {
      await runtime.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log(`PASS ${role}: defaults survive HOME mounts and cwd changes; overrides and bearer auth work`);
