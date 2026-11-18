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

处理进程使用固定脚本、受限环境、时间与输出上限。符合格式的音视频提交到本地处理队列，可选附按时间标记的截图。转写和现有 OCR 文字按原证据生成候选，现场记录阶段不调用外部模型。后端会在运行状态提供依赖缺失原因。后台任务中断后显示失败，用户可以在依赖就绪时明确重试。
