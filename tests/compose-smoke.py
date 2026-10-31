#!/usr/bin/env python3
"""Exercise the real nested deployment and OpenClaw sandbox engine, without account credentials."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import uuid

if len(sys.argv) != 3:
    raise SystemExit('Usage: python3 tests/compose-smoke.py <gateway-image> <sandbox-image>')
root = Path(__file__).resolve().parent.parent
project = 'openclaw-smoke-' + uuid.uuid4().hex[:10]
fixture_volume = project + '-fixtures'
wrong_gateway = project + '-wrong-gateway'
fixture_created = False
compose = None

with tempfile.TemporaryDirectory(prefix=project + '-') as scratch:
    scratch = Path(scratch)
    log = scratch / 'commands.log'

    def call(args, *, input=None, timeout=180, check=True, env=None):
        result = subprocess.run(args, input=input, capture_output=True, text=not isinstance(input, bytes),
                                cwd=root, env=env, timeout=timeout)
        stdout = result.stdout.decode() if isinstance(result.stdout, bytes) else result.stdout
        stderr = result.stderr.decode() if isinstance(result.stderr, bytes) else result.stderr
        with log.open('a') as output:
            output.write('$ ' + ' '.join(args) + '\n' + stdout + stderr + '\n')
        if check and result.returncode:
            raise RuntimeError(f'{args[:5]} failed ({result.returncode}):\n{stdout[-8000:]}{stderr[-3000:]}')
        return stdout.strip()

    try:
        base_env = {**os.environ, 'OPENCLAW_USER_BASE': '/tmp/openclaw-smoke-placeholder',
                    'OPENCLAW_GATEWAY_TOKEN': uuid.uuid4().hex, 'OPENCLAW_GATEWAY_PORT': '0',
                    'OPENCLAW_GATEWAY_IMAGE': sys.argv[1], 'OPENCLAW_SANDBOX_IMAGE': sys.argv[2],
                    'OPENCLAW_PUBLISH_HOST': '127.0.0.1', 'DOCKER_GID': '2375',
                    **{key: '' for key in ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'TICKTICK_API_TOKEN']}}
        render = ['docker', 'compose', '--env-file', '.env.example', '--project-name', project]
        config = json.loads(call(render + ['--profile', 'cli', 'config', '--format', 'json'], env=base_env))
        cli_image = config['services']['openclaw-deploy']['image']
        dind_image = config['services']['openclaw-dind']['image']
        for image in dict.fromkeys([sys.argv[1], sys.argv[2], cli_image, dind_image]):
            inspected = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True)
            if inspected.returncode:
                print('Pulling ' + image, flush=True)
                call(['docker', 'pull', image], timeout=600)
        call(['docker', 'volume', 'create', '--label', 'openclaw.test=compose-smoke', fixture_volume])
        fixture_created = True
        fixture_path = call(['docker', 'volume', 'inspect', fixture_volume, '--format', '{{.Mountpoint}}'])
        base_env['OPENCLAW_USER_BASE'] = fixture_path + '/data'
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as files:
            for source, target in [('compose.inner.yaml', 'compose.inner.yaml'),
                                   ('scripts/compose-inner.sh', 'compose-inner.sh'),
                                   ('config/openclaw.example.json', 'data/config/openclaw.json')]:
                content = (root / source).read_bytes()
                member = tarfile.TarInfo(target)
                member.mode = 0o644
                member.size = len(content)
                files.addfile(member, io.BytesIO(content))
        call(['docker', 'run', '--rm', '--interactive', '--network', 'none', '--entrypoint', 'sh',
              '--mount', f'type=volume,src={fixture_volume},dst=/fixtures', cli_image, '-eu', '-c',
              'tar -xf - -C /fixtures; mkdir -p /fixtures/data/workspace; '
              'chown -R 1000:1000 /fixtures/data; chmod 0700 /fixtures/data /fixtures/data/config /fixtures/data/workspace; '
              'chmod 0600 /fixtures/data/config/openclaw.json'], input=archive.getvalue())
        config = json.loads(call(render + ['--profile', 'cli', 'config', '--format', 'json'], env=base_env))
        # The daemon may be remote from the checkout. Copy only the two nonsecret
        # config files into its fixture volume and point the test at those files.
        config['configs']['openclaw-inner-compose']['file'] = fixture_path + '/compose.inner.yaml'
        config['configs']['openclaw-compose-script']['file'] = fixture_path + '/compose-inner.sh'
        config_file = scratch / 'compose.json'
        config_file.write_text(json.dumps(config))
        compose = ['docker', 'compose', '--project-name', project, '--file', str(config_file)]

        def dc(*args, **kwargs):
            return call(compose + list(args), env=base_env, **kwargs)

        def inner(*args, **kwargs):
            return dc('run', '--rm', '-T', 'openclaw-deploy', *args, **kwargs)

        assert all(name.startswith('openclaw-') for name in config['services'])
        assert 'openclaw-gateway' not in config['services']
        assert config['services']['openclaw-dind']['environment'].get('OPENCLAW_GATEWAY_TOKEN') is None
        assert not any('tcp://' in arg for arg in config['services']['openclaw-dind']['command'])
        print('Starting the isolated DinD fixture...', flush=True)
        dc('up', '--detach', '--wait', '--wait-timeout', '120', 'openclaw-dind', timeout=150)
        print('Loading the exact gateway and sandbox candidates into DinD...', flush=True)
        with log.open('ab') as output:
            save = subprocess.Popen(['docker', 'save', sys.argv[1], sys.argv[2]], stdout=subprocess.PIPE, stderr=output)
            try:
                load = subprocess.run(compose + ['exec', '-T', 'openclaw-dind', 'docker', 'load'],
                                      stdin=save.stdout, stdout=output, stderr=output, timeout=600, env=base_env)
                save.stdout.close()
                assert load.returncode == 0 and save.wait(timeout=30) == 0, 'Candidate image transfer failed'
            finally:
                if save.poll() is None:
                    save.kill()
                    save.wait()
        print('Deploying the real gateway inside DinD...', flush=True)
        inner('up', '--detach', '--wait', '--wait-timeout', '180', '--pull', 'never', timeout=210)
        gateway_id = inner('ps', '--quiet', 'openclaw-gateway')
        assert gateway_id
        outer = subprocess.run(['docker', 'inspect', gateway_id], capture_output=True)
        assert outer.returncode != 0, 'Gateway was accidentally created on the outer daemon'
        dc('run', '--rm', '-T', 'openclaw-cli', 'config', 'validate')
        print('PASS: gateway is managed by DinD; the nested administration CLI validates its configuration', flush=True)
        network = config['networks']['default']['name']
        call(['docker', 'run', '--rm', '--network', network, '--entrypoint', 'wget', cli_image,
              '-q', '-O', '-', 'http://openclaw-dind:18789/healthz'])
        print('PASS: gateway HTTP is reachable through DinD on port 18789', flush=True)
        probe = (root / 'tests/compose-smoke.mjs').read_text()
        print('Reproducing the original topology error with an outer gateway...', flush=True)
        runtime_env = json.loads(inner('config', '--format', 'json'))['services']['openclaw-gateway']['environment']
        # The deliberately wrong gateway must not collide with the live gateway's
        # state ownership lock before it reaches the Docker identity check.
        runtime_env['OPENCLAW_STATE_DIR'] = base_env['OPENCLAW_USER_BASE'] + '/wrong-gateway-state'
        bad_args = ['docker', 'run', '--rm', '--interactive', '--init', '--name', wrong_gateway,
                    '--network', 'none', '--user', '1000:1000', '--group-add', '2375',
                    '--mount', f'type=bind,src={base_env["OPENCLAW_USER_BASE"]},dst={base_env["OPENCLAW_USER_BASE"]}',
                    '--mount', f'type=volume,src={config["volumes"]["dind-socket"]["name"]},dst=/run/dind',
                    '--env', 'OPENCLAW_SMOKE_EXPECT_IDENTITY_ERROR=1']
        for key, value in runtime_env.items():
            bad_args += ['--env', f'{key}={value}']
        bad_args += ['--entrypoint', 'node', sys.argv[1], '--input-type=module']
        print(call(bad_args, input=probe, timeout=150), flush=True)
        print('Running an actual model/tool turn in the nested gateway...', flush=True)
        print(inner('exec', '-T', 'openclaw-gateway', 'node', '--input-type=module', input=probe, timeout=150), flush=True)
        print('Recreating DinD and checking persistence...', flush=True)
        dc('up', '--detach', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'openclaw-dind', timeout=150)
        inner('up', '--detach', '--wait', '--wait-timeout', '180', '--pull', 'never', timeout=210)
        assert inner('ps', '--quiet', 'openclaw-gateway') == gateway_id
        print(inner('exec', '-T', 'openclaw-gateway', 'node', '--input-type=module', input=probe, timeout=150), flush=True)
        print('PASS: inner gateway and sandbox execution survive DinD recreation', flush=True)
    except Exception:
        if compose:
            call(compose + ['logs', '--no-color', '--tail', '40', 'openclaw-dind'], check=False, env=base_env)
        print(log.read_text()[-18000:] if log.exists() else 'No command log', file=sys.stderr)
        raise
    finally:
        subprocess.run(['docker', 'rm', '--force', wrong_gateway], capture_output=True)
        cleanup_errors = []
        if compose:
            result = subprocess.run(compose + ['down', '--volumes', '--remove-orphans'],
                                    env=base_env, capture_output=True, text=True, timeout=180)
            if result.returncode:
                cleanup_errors.append(result.stderr)
        if fixture_created:
            result = subprocess.run(['docker', 'volume', 'rm', fixture_volume], capture_output=True, text=True)
            if result.returncode:
                cleanup_errors.append(result.stderr)
        if cleanup_errors:
            message = 'Test resource cleanup failed: ' + '\n'.join(cleanup_errors)
            if sys.exc_info()[0] is None:
                raise RuntimeError(message)
            print(message, file=sys.stderr)
        else:
            print('PASS: test containers, networks and volumes removed', flush=True)
