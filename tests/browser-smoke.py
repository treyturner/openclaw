#!/usr/bin/env python3
"""Start the browser image's real CMD and check its authenticated local services."""
import json
import subprocess
import sys
import time
import uuid

image = sys.argv[1]
name = 'openclaw-browser-smoke-' + uuid.uuid4().hex[:12]
token = uuid.uuid4().hex
started = False


def docker(*args, check=True, timeout=15):
    result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result


def request(path, *, auth=False, port=9222):
    args = ['exec', name, 'curl', '--noproxy', '*', '--silent', '--show-error',
            '--max-time', '2', '--write-out', '\n%{http_code}']
    if auth:
        args += ['--header', 'Authorization: Bearer ' + token]
    result = docker(*args, f'http://127.0.0.1:{port}{path}', check=False)
    body, _, status = result.stdout.rpartition('\n')
    return body, status


try:
    labels = json.loads(docker('image', 'inspect', image, '--format', '{{json .Config.Labels}}').stdout)
    assert labels.get('org.openclaw.sandbox-browser.contract'), 'Missing browser contract label'
    docker('run', '--detach', '--name', name, '--init', '--read-only', '--network', 'none',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
           '--shm-size', '256m', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m',
           '--env', 'OPENCLAW_BROWSER_CDP_PORT=9222',
           '--env', 'OPENCLAW_BROWSER_CDP_SOURCE_RANGE=127.0.0.0/8',
           '--env', 'OPENCLAW_BROWSER_CDP_AUTH_TOKEN=' + token,
           '--env', 'OPENCLAW_BROWSER_NOVNC_PASSWORD=smoketest',
           # Chromium user namespaces are unavailable on some CI/DinD hosts.
           '--env', 'OPENCLAW_BROWSER_NO_SANDBOX=1', image)
    started = True
    assert docker('exec', name, 'id', '-u').stdout.strip() == '1000'
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        assert docker('inspect', name, '--format', '{{.State.Running}}').stdout.strip() == 'true', \
            'Browser container exited during startup'
        _, status = request('/json/version')
        if status == '401':
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Browser CDP relay did not become ready')
    body, status = request('/json/version', auth=True)
    assert status == '200', (status, body)
    version = json.loads(body)
    assert 'Chrome/' in version['Browser'], version
    assert version['webSocketDebuggerUrl'].startswith('ws://'), version
    print('PASS sandbox-browser: real Chromium CDP responds; unauthenticated requests are rejected', flush=True)

    # Verify the default headed mode starts Xvfb, password-protected VNC and noVNC.
    vnc = '''import socket
with socket.create_connection(('127.0.0.1', 5900), timeout=2) as client:
    with client.makefile('rb') as stream:
        version = stream.read(12)
        assert version == b'RFB 003.008\\n', version
        client.sendall(version)
        count = stream.read(1)[0]
        methods = stream.read(count)
        assert 2 in methods and 1 not in methods, methods
'''
    while time.monotonic() < deadline:
        _, status = request('/vnc.html', port=6080)
        if status == '200':
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('noVNC did not become ready')
    docker('exec', name, 'python3', '-c', vnc)
    print('PASS sandbox-browser: Xvfb, password-protected VNC and noVNC work with a read-only root and no network', flush=True)
except Exception:
    if started:
        logs = docker('logs', '--tail', '60', name, check=False)
        print(logs.stdout + logs.stderr, file=sys.stderr)
    raise
finally:
    # A failed docker run can leave a created container behind before returning.
    docker('rm', '--force', name, check=started)
