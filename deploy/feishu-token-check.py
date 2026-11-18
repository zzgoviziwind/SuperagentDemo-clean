"""Check whether a published self-built app can obtain a token; never print it."""
import getpass
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from superagent.core.feishu_decisions import Config, FeishuAccessPolicyDenied, _token

app_id = sys.argv[1] if len(sys.argv) == 2 else input('App ID: ').strip()
if not re.fullmatch(r'cli_[A-Za-z0-9]+', app_id):
    raise SystemExit('App ID 格式不正确。')
print('应用 ID 已就绪。此检查只获取令牌，不会发送消息。')
secret = getpass.getpass('App Secret（不回显）: ').strip()
if not secret:
    raise SystemExit('未填写 App Secret。')
try:
    _token(Config(app_id, secret, '', '', ''))
except FeishuAccessPolicyDenied as exc:
    raise SystemExit(f'飞书访问策略拒绝（21001）。Log ID: {exc}') from None
except Exception:
    raise SystemExit('没有取得令牌，请查看上面的飞书错误码。') from None
print('新应用获取令牌成功。未发送消息，未显示或保存凭证。')
