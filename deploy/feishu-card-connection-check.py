"""Temporary setup listener. Never sends messages or makes approval decisions."""
import getpass
import logging
import re
import sys
from pathlib import Path


def main():
    sdk_path = Path(__file__).resolve().parents[1] / '.test-tmp' / 'feishu-card-sdk'
    if not (sdk_path / 'lark_oapi').is_dir():
        raise SystemExit('缺少项目内的飞书 SDK，请先安装后再运行。')
    sys.path.insert(0, str(sdk_path))
    import lark_oapi as lark
    from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse

    if sys.argv[1:] == ['--check-sdk']:
        lark.EventDispatcherHandler.builder('', '').register_p2_card_action_trigger(
            lambda _: P2CardActionTriggerResponse()
        ).build()
        print('飞书 SDK 和卡片回调入口可用。')
        return

    if len(sys.argv) == 3 and sys.argv[1] == '--app-id':
        app_id = sys.argv[2].strip()
        print('已预填 App ID，请输入同一应用的 App Secret。', flush=True)
    else:
        app_id = input('App ID (cli_…): ').strip()
    if not re.fullmatch(r'cli_[A-Za-z0-9]+', app_id):
        raise SystemExit('App ID 格式不对，请检查应用的「凭证与基础信息」。')
    secret = getpass.getpass('App Secret（输入不回显）: ').strip()
    if not secret:
        raise SystemExit('未填写 App Secret。')

    def check_only(_):
        return P2CardActionTriggerResponse({
            'toast': {'type': 'info', 'content': '连接检查：未提交审批。'}
        })

    handler = (lark.EventDispatcherHandler.builder('', '')
               .register_p2_card_action_trigger(check_only).build())
    class ConnectionStatusOnly(logging.Filter):
        def filter(self, record):
            message = record.getMessage()
            if message.startswith('connected to '):
                record.msg = '飞书长连接已建立。'
            elif message.startswith('disconnected to '):
                record.msg = '飞书长连接已断开。'
            elif record.levelno >= logging.WARNING:
                record.msg = '飞书连接异常，请检查应用凭证和本机网络。'
            else:
                return False
            record.args = ()
            record.exc_info = None
            return True

    logging.getLogger('Lark').addFilter(ConnectionStatusOnly())
    print('正在连接飞书。看到「长连接已建立」后，保持此窗口开启，再到飞书后台保存长连接。', flush=True)
    try:
        lark.ws.Client(app_id, secret, event_handler=handler, log_level=lark.LogLevel.INFO).start()
    except KeyboardInterrupt:
        print('连接检查已停止。')
    except Exception:
        raise SystemExit('飞书连接未成功，请检查应用凭证和本机网络。') from None


if __name__ == '__main__':
    main()
