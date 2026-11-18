import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.core import db, governance as gov, model_usage as usage


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'usage.db'))
    db.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'Session', factory)
    yield factory
    engine.dispose()


def test_plan_run_is_audited_without_invented_currency(store, monkeypatch):
    monkeypatch.setattr(usage, 'monetary_budget_required', lambda: False)
    result = usage.reserve_model_run('real-plan-turn', None, 'plan', task_id=7)
    assert result == {'id': None, 'billing_mode': 'subscription'}
    with store() as session:
        audit = session.scalar(select(gov.Audit).where(gov.Audit.action == 'model.plan_run'))
        assert audit.resource == 'real-plan-turn'
        assert audit.details == {'task_id': 7, 'billing_mode': 'subscription'}
        assert not session.scalars(select(gov.BudgetReservation)).all()


def test_metered_run_keeps_actual_budget_limit(store, monkeypatch):
    monkeypatch.setattr(usage, 'monetary_budget_required', lambda: True)
    gov.configure_budget('global', 100, 'USD')
    result = usage.reserve_model_run('metered-turn', 60, 'estimate')
    assert result['id'] and result['billing_mode'] == 'metered'
    with pytest.raises(Exception) as error:
        usage.reserve_model_run('over-budget', 50, 'estimate')
    assert getattr(error.value, 'status_code', None) == 409
    with pytest.raises(ValueError):
        usage.reserve_model_run('no-estimate', None, 'estimate')


def test_remote_device_does_not_inherit_local_subscription(store, monkeypatch):
    monkeypatch.setattr(usage, 'monetary_budget_required', lambda: False)
    with pytest.raises(ValueError):
        usage.reserve_model_run('remote', None, 'remote execution', force_metered=True)
