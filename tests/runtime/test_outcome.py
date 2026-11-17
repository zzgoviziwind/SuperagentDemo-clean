import unittest
from superagent.runtime.outcome import assess_outcome

class OutcomeTest(unittest.TestCase):
    def test_completed_turn_with_blocked_tool_is_not_a_fix(self):
        events = [{'method': 'item/completed', 'params': {'item': {'type': 'commandExecution', 'id': 'cmd', 'status': 'failed', 'exitCode': 1, 'aggregatedOutput': 'blocked by policy'}}}]
        result = assess_outcome(task_kind='fix', turn_status='completed', events=events, changes={'diff': '', 'untracked_artifacts': []}, verification=None, outcome={'status': 'incomplete', 'summary': '工具被策略阻止，未修改或测试'})
        self.assertEqual(result['suggested_status'], 'waiting_input')
        self.assertEqual(result['tool_failures'][0]['item_id'], 'cmd')
        self.assertIn('change_evidence_missing', result['reasons'])
        self.assertIn('verification_missing_or_failed', result['reasons'])
        self.assertIn('model_reports_incomplete', result['reasons'])

    def test_turn_completion_alone_does_not_prove_fix_or_analysis(self):
        for kind in ('fix', 'analysis'):
            result = assess_outcome(task_kind=kind, turn_status='completed', events=[], outcome={'status': 'completed'})
            self.assertEqual(result['suggested_status'], 'waiting_input')

    def test_evidenced_fix_is_only_ready_for_review(self):
        result = assess_outcome(task_kind='fix', turn_status='completed', events=[], changes={'diff': 'patch'}, verification={'status': 'passed', 'evidence': 'test record 1'}, outcome={'status': 'completed'})
        self.assertEqual(result['suggested_status'], 'review_ready')

    def test_red_green_test_retains_history_and_clears_only_ordinary_failure(self):
        def command(ident, status, exit_code, output, turn='t'):
            return {'method':'item/completed','params':{'threadId':'th','turnId':turn,'item':{'type':'commandExecution','id':ident,'command':'pytest -q','cwd':'/workspace','status':status,'exitCode':exit_code,'aggregatedOutput':output}}}
        failure=command('red','failed',1,'assertion failed')
        success=command('green','completed',0,'1 passed')
        def assess(events, verification):
            return assess_outcome(task_kind='fix',turn_status='completed',events=events,changes={'diff':'patch'},verification=verification,outcome={'status':'completed'})
        verified={'status':'passed','evidence':{'command_item_ids':['green']}}
        result=assess([failure,success],verified)
        self.assertEqual(result['suggested_status'],'review_ready')
        self.assertTrue(result['tool_failures'][0]['recovered'])
        self.assertEqual(result['blocking_tool_failures'],[])
        self.assertEqual(assess([failure,success],{'status':'unverified'})['suggested_status'],'waiting_input')
        self.assertEqual(assess([failure,command('green','completed',0,'ok','other')],verified)['suggested_status'],'waiting_input')
        self.assertEqual(assess([command('red','failed',1,'blocked by policy'),success],verified)['suggested_status'],'waiting_input')
        self.assertEqual(assess([command('red','declined',1,'denied'),success],verified)['suggested_status'],'waiting_input')
        self.assertEqual(assess([{'method':'error','params':{}},success],verified)['suggested_status'],'waiting_input')

    def test_retry_error_requires_same_completed_turn_and_verified_evidence(self):
        error={'method':'error','params':{'threadId':'th','turnId':'t','willRetry':True,'error':{'message':'retry','codexErrorInfo':{'responseStreamDisconnected':{'httpStatusCode':None}}}}}
        completion={'method':'turn/completed','params':{'threadId':'th','turn':{'id':'t','status':'completed'}}}
        def assess(events, verification, status='completed'):
            return assess_outcome(task_kind='fix',turn_status=status,events=events,changes={'diff':'patch'},verification=verification,outcome={'status':'completed'})
        evidence={'status':'passed','evidence':{'command_item_ids':['test']}}
        result=assess([error,completion],evidence)
        self.assertEqual(result['suggested_status'],'review_ready')
        self.assertTrue(result['tool_failures'][0]['recovered'])
        self.assertEqual(result['blocking_tool_failures'],[])
        self.assertEqual(assess([error,completion],{'status':'unverified'})['suggested_status'],'waiting_input')
        self.assertEqual(assess([error],evidence)['suggested_status'],'waiting_input')
        self.assertEqual(assess([error,{'method':'turn/completed','params':{'threadId':'th','turn':{'id':'other','status':'completed'}}}],evidence)['suggested_status'],'waiting_input')
        for key in ('httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected'):
            event={'method':'error','params':{**error['params'],'error':{'message':'retry','codexErrorInfo':{key:{'httpStatusCode':None}}}}}
            self.assertEqual(assess([event,completion],evidence)['suggested_status'],'review_ready')
        for update in ({'willRetry':False},{'willRetry':None},{'error':{'message':'blocked','codexErrorInfo':'cyberPolicy'}},{'error':{'message':'unknown'}},{'error':{'message':'unknown','codexErrorInfo':'other'}},{'error':{'message':'unknown','codexErrorInfo':{'policyVariant':{}}}},{'error':{'message':'exhausted','codexErrorInfo':{'responseTooManyFailedAttempts':{}}}}):
            event={'method':'error','params':{**error['params'],**update}}
            self.assertEqual(assess([event,completion],evidence)['suggested_status'],'waiting_input')
