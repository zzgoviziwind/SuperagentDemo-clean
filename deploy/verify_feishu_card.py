"""One opt-in real Feishu card; fake Worker and an isolated HTTP service."""
import json
import os
import re
import sqlite3
import sys
import time
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests' / 'e2e'))
from test_blackbox import BlackBoxAcceptance

STATUS = ROOT / '.test-tmp' / 'feishu-live-smoke' / 'status.json'


def report(stage, **data):
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    temp = STATUS.with_suffix('.next')
    temp.write_text(json.dumps({'stage': stage, **data}), encoding='utf-8')
    temp.replace(STATUS)


class Acceptance(BlackBoxAcceptance):
    def diagnostics(self):
        transcript = (self.root / 'service.log').read_text(encoding='utf-8', errors='replace')
        # Extract only known, bounded diagnostics before the isolated log is removed.
        return re.findall(
            r'(?m)^Feishu (?:API HTTP error: status=\d{3} code=(?:\d{1,12}|unknown)'
            r'|(?:token|card or reminder) rejected: code=(?:\d{1,12}|unknown)'
            r'|token blocked by access policy: code=21001 log_id=[A-Za-z0-9_-]{8,100}'
            r'|card (?:connection failed|listener unavailable): [A-Za-z]{1,60}(?: code=(?:\d{1,12}|unknown))?'
            r'|decision reminder (?:failed|unknown) for approval \d{1,12}'
            r'|decision reminder scan failed: [A-Za-z]{1,60})\s*$', transcript)[-8:]

    def fail_with_context(self, message):
        self.safe_failure = message
        self.safe_diagnostics = self.diagnostics()
        self.fail(message)

    def start(self):
        self.environment.update({
            key: os.environ[key] for key in
            ('SUPERAGENT_FEISHU_APP_ID', 'SUPERAGENT_FEISHU_OPEN_ID', 'SUPERAGENT_FEISHU_APP_SECRET')
        })
        self.environment.update({
            'SUPERAGENT_FEISHU_ENABLED': '1', 'SUPERAGENT_FEISHU_MODE': 'card',
            'SUPERAGENT_FEISHU_OWNER_ID': 'admin', 'SUPERAGENT_ATTACHMENTS_ROOT': str(self.root / 'attachments'),
            'SUPERAGENT_ROUTER_WORKSPACES_ROOT': str(self.root / 'router'),
            'PYTHONPATH': os.pathsep.join((str(ROOT), os.environ['PYTHONPATH'])),
        })
        super().start()

    def verify_one_card(self):
        task = self.create_task()
        pending = self.wait_status(task, {'waiting_approval'})
        approval_id = pending['approvals'][-1]['id']
        report('waiting_for_send', task_id=task['id'], approval_id=approval_id)
        print('隔离任务已进入待审批，正在等待飞书连接和发卡。', flush=True)
        db_uri = (self.root / 'control.db').as_uri() + '?mode=ro'
        for _ in range(75):
            if any('token blocked by access policy' in line for line in self.diagnostics()):
                self.fail_with_context('飞书访问策略拒绝发卡令牌（21001）。请联系租户管理员或飞书技术支持。')
            with closing(sqlite3.connect(db_uri, uri=True)) as db:
                row = db.execute('SELECT status FROM feishu_decision_notices WHERE approval_id=?',
                                 (approval_id,)).fetchone()
            if row and row[0] == 'sent':
                break
            if row and row[0] in ('failed', 'unknown'):
                self.fail_with_context(f'飞书卡片发送未获确认（{row[0]}）。')
            time.sleep(1)
        else:
            self.fail_with_context('75 秒内没有收到卡片发送确认。')
        report('ready_to_approve', task_id=task['id'], approval_id=approval_id)
        print('已确认飞书收到发送请求。请在机器人私聊里点测试卡片的「批准」并确认。', flush=True)
        for _ in range(240):
            ready = self.detail(task)
            if ready['task']['status'] == 'review_ready':
                break
            recorded = next((a for a in ready['approvals'] if a['id'] == approval_id), {})
            if recorded.get('status') in ('rejected', 'unknown'):
                self.fail_with_context('审批被拒绝或结果未知，未通过本次续跑验收。')
            time.sleep(1)
        else:
            self.fail_with_context('等待飞书批准超时。没有从工作台代审。')
        workspace = Path(ready['task']['workspace_path'])
        self.assertEqual((workspace / 'result.txt').read_text().strip(), 'verified offline artifact')
        self.assertFalse((self.repo / 'result.txt').exists())
        self.assertEqual(self.git('status', '--porcelain'), b'')
        verification = [a for a in ready['artifacts'] if a['kind'] == 'verification']
        self.assertTrue(verification)
        evidence = json.loads(verification[-1]['content'])
        self.assertEqual(evidence.get('exit_code', evidence.get('returncode')), 0)
        with closing(sqlite3.connect(db_uri, uri=True)) as db:
            audit = db.execute("SELECT details FROM governance_audit WHERE action='approval.decide' AND resource=?",
                               (str(approval_id),)).fetchall()
        self.assertEqual([json.loads(row[0]).get('source') for row in audit], ['feishu'])
        self.receipt = dict(task_id=task['id'], approval_id=approval_id, status='review_ready', artifact='result.txt')


if __name__ == '__main__':
    report('starting')
    try:
        test = Acceptance('verify_one_card')
        result = test.run(unittest.TestResult())
        if not result.wasSuccessful():
            raise RuntimeError(getattr(test, 'safe_failure', '隔离任务未通过，请核对连接、收件人及飞书卡片状态。'))
        report('passed', **test.receipt)
    except BaseException as exc:
        last_stage = json.loads(STATUS.read_text(encoding='utf-8')).get('stage')
        reason = getattr(test, 'safe_failure', f'验收未通过：{type(exc).__name__}。')
        diagnostics = [line.strip() for line in getattr(test, 'safe_diagnostics', [])]
        report('failed', previous_stage=last_stage, error=type(exc).__name__, reason=reason, diagnostics=diagnostics)
        print(reason, file=sys.stderr)
        for line in diagnostics:
            print(line, file=sys.stderr)
        sys.exit(1)
