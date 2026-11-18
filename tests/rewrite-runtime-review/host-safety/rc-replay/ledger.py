"""Run the original real-crash acceptance cases against a fingerprinted dist."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from candidate import canonical_digest, file_sha, materialize, tree
from prepared import exercise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, required=True)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--expect-main', required=True)
    parser.add_argument('--expect-dist', required=True)
    parser.add_argument('--expect-zip')
    args = parser.parse_args()
    if not __debug__:
        parser.error('enable assertions')
    inputs = [Path(__file__), HERE / 'candidate.py', HERE.parent / 'prepared.py',
              HERE.parent / 'oracle.py', HERE.parent / 'prepare-guard.cjs']
    with tempfile.TemporaryDirectory(prefix='l-', dir=HERE) as temp:
        work = Path(temp)
        node = args.node.resolve() if args.node else None
        dist, node, info = materialize(args.dist, work, node, args.expect_zip)
        if (info['main_sha256'], info['dist_sha256']) != (args.expect_main.lower(), args.expect_dist.lower()):
            raise ValueError('candidate does not match requested fingerprints')
        version = subprocess.check_output([node, '--version'], text=True).strip()
        assert version.startswith('v24.'), version
        stamp = datetime.now(timezone.utc)
        run_id = stamp.strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        out = HERE / 'evidence' / info['dist_sha256'] / run_id
        out.mkdir(parents=True)
        report = {'candidate': info, 'utc': stamp.isoformat(), 'node': version,
                  'python': sys.version.split()[0], 'runner_files': {p.name: file_sha(p) for p in inputs}, 'cases': {}}
        with ThreadPoolExecutor(max_workers=4) as pool:
            pending = {mode: pool.submit(exercise, node, dist / 'main.js', work / mode, mode)
                       for mode in ('default', 'stock', 'direct-default', 'direct-stock')}
            for mode, future in pending.items():
                try:
                    case = {'pass': True, 'observed': future.result()}
                except Exception:
                    case = {'pass': False, 'error': traceback.format_exc().replace(temp, '<scratch>')}
                report['cases'][mode] = case
                print(mode, case.get('error', 'pass'), flush=True)
        report['dist_unchanged'] = canonical_digest(tree(dist)) == info['dist_sha256']
        report['pass'] = report['dist_unchanged'] and all(case['pass'] for case in report['cases'].values())
        with (out / 'ledger.json').open('x', encoding='utf-8') as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print(out / 'ledger.json', flush=True)
        return int(not report['pass'])


if __name__ == '__main__':
    sys.exit(main())
