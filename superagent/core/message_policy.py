"""Small, deterministic DingTalk response policy shared by routing and settings."""
from .governance import Setting


DEFAULT_POLICY = {'direct_messages': 'reply', 'group_messages': 'requests',
                  'delivery': 'draft', 'default_project_id': None}
DEFAULT_REPLY_MAX_AGE_MINUTES = 120


def validate_policy(value):
    group_fields = {'group_scope', 'group_chat_ids', 'group_names', 'group_original_names'}
    optional = group_fields | {'reply_guidance', 'reply_max_age_minutes'}
    if not isinstance(value, dict) or not set(DEFAULT_POLICY) <= set(value) or set(value) - set(DEFAULT_POLICY) - optional:
        raise ValueError('消息策略需要私聊、群聊、交付与默认项目四项设置')
    if value['direct_messages'] not in ('reply', 'off'):
        raise ValueError('私聊策略无效')
    if value['group_messages'] not in ('mentions', 'requests', 'off'):
        raise ValueError('群聊策略无效')
    if value['delivery'] not in ('draft', 'approved_send', 'auto_send'):
        raise ValueError('交付策略需要选择草稿、批准后发送或自动发送')
    project = value['default_project_id']
    if project is not None and (type(project) is not int or project <= 0):
        raise ValueError('默认项目必须为正整数或空')
    guidance = value.get('reply_guidance', '')
    max_age = value.get('reply_max_age_minutes', DEFAULT_REPLY_MAX_AGE_MINUTES)
    if not isinstance(guidance, str) or len(guidance) > 1000:
        raise ValueError('模型回复规则最多 1000 字')
    if type(max_age) is not int or not 1 <= max_age <= 1440:
        raise ValueError('自动回复有效期需为 1 至 1440 分钟')
    if set(value) & group_fields:
        if value.get('group_scope') not in ('all', 'selected'):
            raise ValueError('群接收范围必须选择所有群或指定群')
        chats = value.get('group_chat_ids')
        if (not isinstance(chats, list) or len(chats) > 100 or
                any(not isinstance(chat, str) or not chat.strip() or chat != chat.strip() for chat in chats) or
                len(set(chats)) != len(chats)):
            raise ValueError('指定群需要提供不重复的群标识列表，最多 100 个')
        for field in ('group_names', 'group_original_names'):
            names = value.get(field, {})
            if not isinstance(names, dict) or len(names) > 100 or any(not isinstance(k, str) or not isinstance(v, str) or len(v) > 200 for k, v in names.items()):
                raise ValueError('群名称配置无效')
    return dict(value)


def response_policy(session, settings=None):
    row = session.get(Setting, 'dingtalk_response_policy')
    value = settings('dingtalk_response_policy', None) if settings else row.value if row else None
    if value is not None:
        return validate_policy(value)
    legacy = session.get(Setting, 'dingtalk_route_all_mentions')
    all_mentions = settings('dingtalk_route_all_mentions', False) if settings else legacy.value if legacy else False
    return DEFAULT_POLICY | {'group_messages': 'mentions' if all_mentions is True else 'requests'}


def conversation_type(metadata):
    # This event key is published by DWS specifically for all direct messages.
    if metadata.get('dws_event_type') == 'user_im_message_receive_o2o_all':
        return 'direct'
    return 'group' if metadata.get('dws_event_type') in (
        'user_im_message_receive_group', 'user_im_message_receive_group_all') else 'unknown'


def policy_allows(policy, metadata, conversation_id=None):
    if conversation_type(metadata) == 'direct':
        return policy['direct_messages'] == 'reply'
    mode = policy['group_messages']
    if mode == 'requests' and policy.get('group_scope') == 'selected' and conversation_id not in policy['group_chat_ids']:
        return False
    return mode != 'off' and (mode != 'mentions' or metadata.get('at_me') is True)
