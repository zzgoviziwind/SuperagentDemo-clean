# 候选包 119 项复验入口

## 接收最终实包

收到主控给出的实际 EXE 或 ZIP 绝对路径后，先运行下列命令固定外层文件。如果同时收到该文件的 SHA-256，追加 `--sha256 $packageSha` 核对。接收入口只读取交付文件，生成一份私有副本和收件记录。后续隔离安装及 119 回放分别记录包版本、包内 Node、实际服务入口和完整 dist 指纹。安装包包含的助手文件也计入实包 dist 指纹。

```powershell
$python = 'E:/Workspace/Workspace/Project/SuperAgentDemo/.venv/Scripts/python.exe'
& $python -IB -X utf8 tests/rewrite-acceptance/receive_final_package.py $packagePath
```

## 复放固定的服务构建

从工作树根目录运行。输入为实际 dist 目录和主控提供的 **main.js 完整 SHA-256**。如果主控也提供整包散列，追加 `--dist-sha256`。整包算法是对所有文件的“相对路径 → 小写 SHA-256”映射按键排序，以 UTF-8 紧凑 JSON 编码，再求 SHA-256；路径分隔符统一为 `/`。

```powershell
# $dist 为候选目录，$sha 为主控提供的入口 SHA-256。
$python = 'E:/Workspace/Workspace/Project/SuperAgentDemo/.venv/Scripts/python.exe'
$node24 = (Get-Command -All node | Where-Object { $_.Source -like '*CodexPrimaryRuntime*' } | Select-Object -First 1).Source
$suite = 'tests/rewrite-acceptance'
$prepared = & $python -IB -X utf8 "$suite/replay119.py" --node $node24 --dist $dist --entry-sha256 $sha --prepare-only
if ($LASTEXITCODE -ne 0) { throw '候选快照准备失败' }
$run = ($prepared | Select-String '^Run: ').Line.Substring(5)
$evidence = ($prepared | Select-String '^Evidence: ').Line.Substring(10)
& $python -IB -X utf8 "$suite/replay119.py" --node $node24 --resume $run --entry-sha256 $sha --jobs 4 --fail-on-diff
& $python -IB -X utf8 "$suite/replay_load119.py" --node $node24 --seed-run $run
& $python -IB -X utf8 "$suite/replay_recovery.py" --node $node24 --seed-run $run
& $python -IB -X utf8 "$suite/replay_postcheck.py" --node $node24 --seed-run $run
& $python -IB -X utf8 "$suite/check_http119.py" --evidence $evidence --entry-sha256 $sha
```

准备阶段复制整个 dist，重新核对逐文件散列并生成隔离底库。打印的 Run 指向私有快照与底库，Evidence 指向本次归档。各执行阶段沿用同一份快照，启动 TS Host 前逐文件复核。来源冻结指纹及底库散列在后续阶段启动前再次核对。

归档位于 `evidence/candidates/<完整入口 SHA>/<本次运行目录名>/`。serial、load、recovery、postcheck 分别发布到各自子目录。每次从 dist 准备都会分配新运行目录，即使入口 SHA 相同。锁文件和暂存输出留在私有工作目录内。完整结果按阶段一次发布，已有阶段拒绝再次写入。未完成阶段可用同一底库重试。

串行的严格检查会先发布差异报告再返回非零。回切状态不符也会先保存观测后返回非零。核验证据命令检查覆盖与来源，业务裁决仍以串行分类及回切结果为准。原 B328 平面归档继续用无参数的 `check_http119.py` 只读核验。[B328 交接](HANDOFF-119.md) · [32 项字段裁决](B328-32.md)
