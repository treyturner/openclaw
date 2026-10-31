import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';

const marker = `dind-smoke-${randomUUID()}`;
const resultFile = `${process.env.OPENCLAW_WORKSPACE_DIR}/${marker}.txt`;
let requests = 0;
const server = http.createServer(async (request, response) => {
  try {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(request.url, '/v1/chat/completions');
    const toolResult = body.messages.some(message => message.role === 'tool');
    if (!toolResult) assert(body.tools.some(tool => tool.function?.name === 'exec'));
    requests++;
    assert(requests <= 4, 'Agent did not finish after executing the fixture tool');
    const tool = { index: 0, id: 'call_fixture', type: 'function', function: {
      name: 'exec', arguments: JSON.stringify({ command: `printf '${marker}' > /workspace/${marker}.txt`, yieldMs: 1000 }),
    } };
    const message = toolResult ? { role: 'assistant', content: 'Sandbox fixture completed.' }
      : { role: 'assistant', content: null, tool_calls: [tool] };
    const finish = toolResult ? 'stop' : 'tool_calls';
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
  const child = spawn('openclaw', ['agent', '--local', '--agent', 'main', '--session-id', marker,
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
  if (process.env.OPENCLAW_SMOKE_EXPECT_IDENTITY_ERROR === '1') {
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
