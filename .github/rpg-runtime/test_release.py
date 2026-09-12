import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from release import ROOT, release


class ReleaseTest(unittest.TestCase):
    def test_clean_exact_files_publish_and_bad_identity_or_bytes_fail(self):
        config = json.loads((ROOT / 'retrom-fork.json').read_text())
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            candidate = base / 'candidate'
            candidate.mkdir()
            records = []
            for name in config['releaseAssets']:
                if name == 'rpg-runtime-release.json':
                    continue
                data = name.encode()
                (candidate / name).write_bytes(data)
                records.append({'filename': name, 'sizeBytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            descriptor = {'dirty': False, 'commit': 'a' * 40, 'repository': config['forkRepository'],
                          'adapterAbi': config['adapterAbi'], 'files': records}
            metadata = candidate / 'retrom-core-candidate.json'
            metadata.write_text(json.dumps(descriptor))
            tag = 'retrom-core-g2e6fd06ed6c7-r1'
            output = base / 'release'
            release(candidate, output, tag, 'a' * 40)
            self.assertEqual({p.name for p in output.iterdir()}, set(config['releaseAssets']))
            self.assertEqual(json.loads((output / 'rpg-runtime-release.json').read_text())['commit'], 'a' * 40)
            with self.assertRaisesRegex(ValueError, 'TAG_INVALID'):
                release(candidate, base / 'invalid', 'latest', 'a' * 40)
            with self.assertRaisesRegex(ValueError, 'SOURCE_INVALID'):
                release(candidate, base / 'invalid', tag, 'b' * 40)
            descriptor['dirty'] = True
            metadata.write_text(json.dumps(descriptor))
            with self.assertRaisesRegex(ValueError, 'SOURCE_INVALID'):
                release(candidate, base / 'invalid', tag, 'a' * 40)
            descriptor['dirty'] = False
            metadata.write_text(json.dumps(descriptor))
            (candidate / 'ppsspp.wasm').write_bytes(b'altered')
            with self.assertRaisesRegex(ValueError, 'INTEGRITY_INVALID'):
                release(candidate, base / 'invalid', tag, 'a' * 40)
