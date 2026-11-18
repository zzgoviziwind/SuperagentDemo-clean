"""Distinguish an explicitly connected plan account from metered API budgets."""
from . import db
from .governance import Audit, reserve_budget


def monetary_budget_required():
    from .local_agents import uses_subscription_account
    return not uses_subscription_account()


def reserve_model_run(request_key, estimate, basis, *, task_id=None, actor='system', force_metered=False):
    if not force_metered and not monetary_budget_required():
        # Account limits are enforced by the provider. No invented dollar/token
        # conversion or zero-cost reservation is recorded for a plan account.
        with db.Session.begin() as session:
            session.add(Audit(actor=actor, action='model.plan_run', resource=request_key,
                              details={'task_id': task_id, 'billing_mode': 'subscription'}))
        return {'id': None, 'billing_mode': 'subscription'}
    if type(estimate) is not int or estimate <= 0:
        raise ValueError('按量账号需要配置单次预算；本机订阅账号请先在 Agent 页面完成连接')
    result = reserve_budget('global', request_key, estimate, basis, task_id=task_id, actor=actor)
    return {**result, 'billing_mode': 'metered'}
