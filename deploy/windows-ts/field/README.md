# 现场记录 TypeScript 入口

总控在 `apps/server/src/server.ts` 导入 `registerField`，在调用 `app.ready()` 前执行 `registerField(app, store, root, env)`。复用现有 SQLite 的 `field_records`、`field_candidates`、`field_timelines` 和 `field_media_jobs`。所有操作沿用现场记录管理员权限。

基础版使用随安装包提供的 Node，逐行整理笔记，核对截图及导入的时间轴。候选项经人工审核后才能新建或关联只读分析。批准实施需要当前版本的已核验只读分析及同轮摘要，写入独立的修复任务。无本机识别模型时仍可上传截图供人工核对、导入既有 OCR/转写、查看旧记录和已归档音视频。

迁移旧实例时，在复制的数据库旁按原层级复制 `attachments/field` 和 `attachments/field-media`。旧截图的绝对路径只用来提取受管相对层级，文件仍从目标附件目录读取，按旧记录的大小和 SHA-256 校验。旧媒体按原目录和大小复核，保留 HTTP Range 播放。也可通过启动配置显式指定附件目录的绝对路径 `SUPERAGENT_ATTACHMENTS_ROOT`。不要向候选安装实例指向原服务正在使用的目录。

## 可选本机处理

由操作员准备独立 Python 环境及模型，通过安装器 `Configure -InjectEnvironment` 选择以下变量。路径由操作员提供，配置只保存变量名。Windows 安装包在 `apps/server/dist/field-helpers` 内附固定处理脚本。

| 变量 | 内容 |
| --- | --- |
| `SUPERAGENT_FIELD_PYTHON` | 独立环境的 `python.exe` 绝对路径 |
| `SUPERAGENT_FIELD_OCR_MODELS` | 含 `tessdata/chi_sim.traineddata` 和 `tessdata/eng.traineddata` 的目录。环境另需 Pillow 与 tesserocr |
| `SUPERAGENT_FIELD_WHISPER_MODEL` | 含 `model.bin`、`config.json` 和 `tokenizer.json` 的已安装 faster-whisper 模型。环境另需 PyAV、NumPy、faster-whisper |

截图识别与语音识别可单独启用。处理含视频的 MP4 或 WebM 并抽帧时，Python 还需 Pillow。先在独立环境准备软件包与本机模型，然后在同一个 PowerShell 中选择需要注入的变量并重启。以下路径为示例。

```powershell
$manager = "$env:LOCALAPPDATA\SuperAgent\SuperAgent.cmd"
$env:SUPERAGENT_FIELD_PYTHON = 'D:\SuperAgentTools\field-venv\Scripts\python.exe'
$env:SUPERAGENT_FIELD_OCR_MODELS = 'D:\SuperAgentTools\models\ocr'
$env:SUPERAGENT_FIELD_WHISPER_MODEL = 'D:\SuperAgentTools\models\whisper'
& $manager -Action Configure -InjectEnvironment 'SUPERAGENT_FIELD_PYTHON,SUPERAGENT_FIELD_OCR_MODELS,SUPERAGENT_FIELD_WHISPER_MODEL'
& $manager -Action Diagnose
& $manager -Action Restart
```

`-InjectEnvironment` 替换整份已选名单。只启用一种处理时，从名单去掉另一个模型变量。实例已有认证、渠道或其他注入项时，一并保留所需名字。从同一个具备已选变量的启动环境重启、升级或回滚，`Diagnose` 会列出缺失名字。

现场记录从 `/api/v1/field-intake/organizer` 读取截图识别与时间轴能力。基础版提供逐行整理与截图人工核对，同时接受时间轴导入。媒体能力和缺失提示来自 `/api/v1/field-intake/media-jobs`。看见媒体输入可用后，先用一段短录音验证本机转写和候选审核，再处理正式材料。失败任务在依赖就绪后可重试。

辅助进程只调用包内固定脚本，使用受限环境、时间和输出上限。媒体队列在本机转写并按需抽帧。转写和已有 OCR 文字按原证据生成候选，人工审核后才创建或关联只读分析。批准实施消耗当前分析的状态版本，并创建独立修复任务。
