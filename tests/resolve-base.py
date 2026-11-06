#!/usr/bin/env python3
"""Exercise the resolver against registry and upstream-Dockerfile fixtures."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from textwrap import dedent
import unittest

ACTION = Path(__file__).resolve().parents[1] / '.github/actions/resolve/base/action.yml'
# The action ends with one literal run block. Execute that exact inline body,
# with the same Bash options as Actions, without adding a YAML test dependency.
RESOLVER = dedent(ACTION.read_text().split('      run: |\n', 1)[1])
PIN = 'sha256:' + 'a' * 64
LATEST = 'sha256:' + 'b' * 64
DOCKERFILE = f'FROM debian:bookworm-slim@{PIN}\nLABEL org.openclaw.sandbox-browser.contract="test-contract"\n'


class ResolveBase(unittest.TestCase):
    def resolve(self, role='', ref='', *, dockerfile=DOCKERFILE, release='2026.11.1', digest=LATEST):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.github').mkdir()
            (root / '.github/openclaw-version').write_text(release + '\n')
            (root / 'upstream').write_text(dockerfile)
            (root / 'bin').mkdir()
            stub = '''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['FIXTURE_CALLS'], 'a') as output:
    output.write(json.dumps([pathlib.Path(sys.argv[0]).name, *args]) + '\\n')
if pathlib.Path(sys.argv[0]).name == 'curl':
    pathlib.Path(args[args.index('-o') + 1]).write_text(pathlib.Path(os.environ['FIXTURE_UPSTREAM']).read_text())
elif args[:3] == ['buildx', 'imagetools', 'inspect']:
    print(os.environ['FIXTURE_DIGEST'])
elif args[:2] == ['image', 'inspect']:
    print('test/version:1')
elif args[0] != 'pull':
    sys.exit('Unexpected docker invocation')
'''
            for name in ['curl', 'docker']:
                path = root / 'bin' / name
                path.write_text(stub)
                path.chmod(0o755)
            env = {**os.environ, 'GITHUB_WORKSPACE': str(root), 'GITHUB_OUTPUT': str(root / 'output'),
                   'IMAGE_ROLE': role, 'UPSTREAM_IMAGE_REF': ref,
                   'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH'],
                   'FIXTURE_CALLS': str(root / 'calls'), 'FIXTURE_UPSTREAM': str(root / 'upstream'),
                   'FIXTURE_DIGEST': digest}
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', RESOLVER],
                                    env=env, text=True, capture_output=True)
            outputs = dict(line.split('=', 1) for line in (root / 'output').read_text().splitlines()) \
                if (root / 'output').exists() else {}
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()] \
                if (root / 'calls').exists() else []
            return result, outputs, calls

    def test_generic_image_keeps_label_version(self):
        result, outputs, _ = self.resolve(ref='ghcr.io/jdx/mise:2026.10.17-debian')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs['base_ref'], 'ghcr.io/jdx/mise:2026.10.17-debian@' + LATEST)
        self.assertEqual(outputs['version'], 'test-version-1')
        self.assertEqual(outputs['short_digest'], 'b' * 12)

    def test_gateway_uses_shared_release(self):
        result, outputs, calls = self.resolve('gateway')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs['base_ref'], 'ghcr.io/openclaw/openclaw:2026.11.1@' + LATEST)
        self.assertEqual(calls[0][4], 'ghcr.io/openclaw/openclaw:2026.11.1')

    def test_browser_preserves_release_pin_and_contract(self):
        result, outputs, calls = self.resolve('sandbox-browser')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs['base_ref'], 'debian:bookworm-slim@' + PIN)
        self.assertEqual(outputs['digest'], PIN)
        self.assertEqual(outputs['short_digest'], 'a' * 12)
        self.assertEqual(outputs['version'], '2026.11.1')
        self.assertEqual(outputs['browser_contract'], 'test-contract')
        self.assertIn('/v2026.11.1/', calls[0][4])
        self.assertFalse(any('imagetools' in call for call in calls))

    def test_rejects_missing_unpinned_and_ambiguous_browser_metadata(self):
        for dockerfile in ['', DOCKERFILE.replace('@' + PIN, ''), DOCKERFILE + 'FROM debian:other\n',
                           DOCKERFILE.split('LABEL')[0], DOCKERFILE + 'LABEL org.openclaw.sandbox-browser.contract="other"\n']:
            with self.subTest(dockerfile=dockerfile):
                result, outputs, calls = self.resolve('sandbox-browser', dockerfile=dockerfile)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})
                self.assertFalse(any(call[0] == 'docker' for call in calls))

    def test_rejects_invalid_release_digest_and_missing_ref(self):
        for kwargs in [dict(role='gateway', release='../main'), dict(ref='debian:bookworm', digest='invalid'), {}]:
            with self.subTest(kwargs=kwargs):
                result, outputs, _ = self.resolve(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})


if __name__ == '__main__':
    unittest.main()
