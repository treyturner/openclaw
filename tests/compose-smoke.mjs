import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';

const marker = `dind-smoke-${randomUUID()}`;
const setupProbe = process.env.OPENCLAW_SMOKE_SETUP;
const resultFile = `${process.env.OPENCLAW_WORKSPACE_DIR}/${marker}.txt`;
let requests = 0;
const server = http.createServer(async (request, response) => {
  try {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(request.url, '/v1/chat/completions');
    const toolResult = body.messages.some(message => message.role === 'tool');
    if (setupProbe) assert(!body.tools?.length, 'Setup inference should disable tools');
    else if (!toolResult) assert(body.tools.some(tool => tool.function?.name === 'exec'));
    requests++;
    assert(requests <= 4, 'Agent did not finish after executing the fixture tool');
    const tool = { index: 0, id: 'call_fixture', type: 'function', function: {
      name: 'exec', arguments: JSON.stringify({ command: `printf '${marker}' > /workspace/${marker}.txt`, yieldMs: 1000 }),
    } };
    const message = setupProbe ? { role: 'assistant', content: 'OK' }
      : toolResult ? { role: 'assistant', content: 'Sandbox fixture completed.' }
      : { role: 'assistant', content: null, tool_calls: [tool] };
    const finish = setupProbe || toolResult ? 'stop' : 'tool_calls';
    const base = { id: 'chatcmpl_fixture', created: Math.floor(Date.now() / 1000), model: 'fixture-model' };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
  config.models = { providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 16384, maxTokens: 1024 }],
  } } };
  config.agents.defaults.model = { primary: 'fixture/fixture-model' };
  config.agents.defaults.models = { 'fixture/fixture-model': {} };
  const configPath = `/tmp/${marker}.json`;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  // Use the shipped setup API so its real os.tmpdir() workspace allocation,
  // sandbox mount translation and inference path are covered without a UI.
  const setupScript = `
    import { verifySetupInference } from '/app/dist/system-agent/setup-inference.js';
    const result = await verifySetupInference({ agentId: 'main', timeoutMs: 60000,
      runtime: { log: () => {}, error: console.error } });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  `;
  const child = spawn(setupProbe ? 'node' : 'openclaw', setupProbe
    ? ['--input-type=module', '--eval', setupScript]
    : ['agent', '--local', '--agent', 'main', '--session-id', marker,
      '--message', 'Run the supplied exec tool command, then finish.', '--json'], {
    // Embedded turns need their own state directory while the HTTP gateway is
    // live. They still run in the gateway container and use its Docker socket,
    // so OpenClaw's real self-inspection and sandbox lifecycle are exercised.
    env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: `${process.env.OPENCLAW_STATE_DIR}/smoke/${marker}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  if (setupProbe === 'tmpfs') {
    assert.notEqual(code, 0, output);
    assert.match(output, /Sandbox mount source \/tmp\/openclaw-setup-inference-.*uses an unsupported tmpfs mount/, output);
    assert.equal(requests, 0, 'tmpfs rejection must happen before inference');
    console.log('PASS: setup inference reproduces the unsupported /tmp tmpfs error');
  } else if (setupProbe === 'bind') {
    assert.equal(code, 0, output);
    assert.equal(requests, 1, output);
    console.log('PASS: setup inference completes using the bind-backed TMPDIR');
  } else if (process.env.OPENCLAW_SMOKE_EXPECT_IDENTITY_ERROR === '1') {
    assert.notEqual(code, 0, output);
    assert.match(output, /Cannot resolve sandbox bind sources from this Gateway container/, output);
    console.log('PASS: OpenClaw rejects an outer gateway connected to the inner daemon');
  } else {
    assert.equal(code, 0, output);
    assert(requests >= 2, output);
    assert.equal(await readFile(resultFile, 'utf8'), marker, output);
    console.log('PASS: OpenClaw created a sandbox and executed its tool against the shared workspace');
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
