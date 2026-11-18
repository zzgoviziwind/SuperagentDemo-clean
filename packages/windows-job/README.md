# Windows 子进程所有权

运行时导入 `@superagent/windows-job`。公开入口是 `index.mjs`，类型声明是 `index.d.ts`。发行包随附 x64 原生程序 `bin/windows-job-x64.exe`。适用环境为 Windows 10 及以上的 x64 系统。

```ts
const owned = await spawnOwned(executable, args, { cwd, env });
const { child, pid } = owned;
// child.stdin / stdout / stderr 是协议流。pid 是实际协议进程的 PID。
child.once('close', (code, signal) => recordExit(code, signal));
// 优雅停止使用 child.stdin.end()；需要强退时使用 owned.terminate()。
```

调用方传入已解析的绝对程序路径、绝对 cwd 和显式环境对象，并继续负责项目与账号授权。包装使用 Windows 为其收到的参数构造的命令行启动目标，保留空参数、空格、引号和反斜杠。Windows 的 `child.pid` 指向监督进程，`owned.pid` 来自就绪管道。正常完成保留目标退出码；强退返回 1；包装失败返回 125。启动失败时 Promise 拒绝，启动诊断仅包含阶段和系统错误号。

### 生命周期

监督进程独占匿名 Job 的句柄并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。在同一次 `CreateProcessW` 中指定 `CREATE_SUSPENDED` 与 `PROC_THREAD_ATTRIBUTE_JOB_LIST`。确认根已属于 Job，且所有者仍在后，才恢复主线程。允许继承的句柄只有三条标准流各自的副本。[Windows 进程创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

fd 3 专用于就绪消息，fd 4 专用于所有者生存与停止通知。协议输出始终使用 stdout。根退出、收到停止字节、所有者管道断开，都会触发 Job 终止，并等待内核报告活动进程数为零。若监督进程被直接终止，内核关闭最后一个 Job 句柄后回收其成员。运行时须等 `child.close` 观察结束，不以调用 `terminate()` 作为退出确认。[Windows Job 对象](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

### 构建和随包分发

模块以自身 URL 定位 `./bin/windows-job-x64.exe`。有两种对应布局：

- 作为外部生产依赖分发时，复制本包，保留 `index.mjs` 同级的 `bin/` 目录。
- 将模块编进单文件服务器时，把 exe 复制到服务器入口同级的 `bin/`。例如 `apps/server/dist/main.js` 对应 `apps/server/dist/bin/windows-job-x64.exe`。

发行件已包含编译产物，启动时直接使用。开发者可以用 x86_64 MinGW-w64 执行 `node packages/windows-job/build.mjs` 复建，通过 `WINDOWS_JOB_CC` 选择兼容编译器。源码位于 `src/windows-job.c`。

在仓库根执行 `node --test packages/windows-job/test/ownership.test.mjs` 检查协议和启动边界。跨 Node、Python 的完整进程树退出用例保留在 `tests/rewrite-runtime-review/candidate_checks.py`，使用已接入本包的运行时从公开入口验证。
