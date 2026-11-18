"""Isolated product preview, synthetic events only; never loads live channel settings."""
import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def prepare(state):
    os.environ['SUPERAGENT_SERVICE_MODE'] = 'preview'
    state = Path(state).resolve()
    state.mkdir(parents=True, exist_ok=True)
    os.environ['SUPERAGENT_DATABASE_URL'] = 'sqlite:///' + (state / 'preview.db').as_posix()
    os.environ['SUPERAGENT_ATTACHMENTS_ROOT'] = str(state / 'attachments')
    # A preview is local only and intentionally disconnected from accounts/channels.
    for name in ('SUPERAGENT_API_TOKEN', 'SUPERAGENT_USERS_JSON', 'SUPERAGENT_DINGTALK_CONFIG',
                 'SUPERAGENT_REDMINE_CONFIG', 'SUPERAGENT_CODEX_EXECUTABLE'):
        os.environ.pop(name, None)
    from superagent.main import app
    from superagent.core.db import init_db, Session, Project, Task, Event
    from superagent.core.governance import update_settings
    from superagent.core.ingestion import ingest_event
    from sqlalchemy import select
    init_db()
    update_settings({'scheduler_enabled': False, 'router_agent_enabled': False,
                     'semantic_routing_enabled': False, 'watchdog_enabled': False,
                     'external_delivery_enabled': False,
                     'connectors.dingtalk': {'enabled': False}, 'connectors.redmine': {'enabled': False}})
    with Session.begin() as s:
        project = s.scalar(select(Project).where(Project.name == '产品验收演示 · 模拟数据'))
        if project is None:
            project = Project(name='产品验收演示 · 模拟数据', repo_path=str(ROOT),
                              dingtalk_chat_ids=['preview-chat'], redmine_project_ids=['preview-project'])
            s.add(project)
            s.flush()
        project_id = project.id
    actor = lambda source, ident: {'user_id': 'admin', 'role': 'admin', 'project_ids': [project_id],
                                   'permissions': ['request']} if ident == 'preview-user' else None
    receipt = ingest_event({'source': 'dingtalk', 'external_id': 'preview-1', 'event_type': 'message.received',
        'actor_id': 'preview-user', 'project_external_id': 'preview-chat', 'thread_id': 'preview-chat',
        'content': '请只读分析 #1001 的事件来源与订阅关系（模拟验收任务）',
        'metadata': {'message_id': 'preview-1', 'profile': 'preview'}}, actor_resolver=actor)
    ingest_event({'source': 'dingtalk', 'external_id': 'preview-2', 'event_type': 'message.received',
        'actor_id': 'preview-user', 'project_external_id': 'preview-chat', 'thread_id': 'preview-chat',
        'content': '补充：重点关注没有进入 Worker 的消息',
        'metadata': {'message_id': 'preview-2', 'reply_to_message_id': 'preview-1', 'profile': 'preview'}}, actor_resolver=actor)
    ingest_event({'source': 'redmine', 'external_id': 'preview-blocked', 'event_type': 'issue.updated',
        'actor_id': 'unknown-preview-user', 'project_external_id': 'preview-project',
        'content': '未知身份的请求（模拟拒绝案例）', 'metadata': {}}, actor_resolver=actor)
    with Session.begin() as s:
        task = s.get(Task, receipt['task_id'])
        task.status = 'paused'
        if not s.scalar(select(Event).where(Event.task_id == task.id, Event.event_type == 'assistant_message')):
            s.add(Event(task_id=task.id, source='runtime', event_type='assistant_message',
                        content='这是界面验收示例消息。事件已关联任务，执行保持暂停；未运行真实模型或业务操作。',
                        data={'preview': True}))
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', default=str(ROOT / '.test-tmp' / 'product-preview'))
    parser.add_argument('--port', type=int, default=8876)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(prepare(args.state), host='127.0.0.1', port=args.port)
