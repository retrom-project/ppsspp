import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import candidate_descriptor


class DescriptorTest(unittest.TestCase):
    def test_detached_ci_checkout_preserves_exact_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'
            output = Path(temporary) / 'output'
            root.mkdir(); output.mkdir()
            config = {'releaseAssets': ['asset.js', 'rpg-runtime-release.json'],
                      'forkRepository': 'https://github.com/retrom-project/ppsspp', 'adapterAbi': 'ppsspp-host-v1'}
            (root / 'retrom-fork.json').write_text(json.dumps(config))
            (output / 'asset.js').write_text('test')
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-q'); git('add', '.')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
            commit = git('rev-parse', 'HEAD')
            git('checkout', '--detach', '-q', commit)
            with patch.object(candidate_descriptor, 'ROOT', root):
                candidate_descriptor.finalize(output, 'play')
            record = json.loads((output / 'retrom-core-candidate.json').read_text())
            self.assertEqual(record['commit'], commit)
            self.assertEqual(record['branch'], 'HEAD')
            self.assertFalse(record['dirty'])
