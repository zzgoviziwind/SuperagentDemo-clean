# 现场记录 OCR 对照与真实归纳验收

2026-11-18。使用从零生成、不含真实患者信息的四张虚构医院界面截图。覆盖报告预览、科室详情、暗色导出清单和灰底小字同步提示。四张图和一份交流笔记构成一次完整现场样本。截图脚本用 Windows 微软雅黑绘制，包含中文、英文、编号和状态码。样本与逐行 OCR 输出位于 `.test-tmp/field-ocr-benchmark/`。

## OCR 选择

同一 CPU、原图尺寸和参考文本。比较参考文本和识别结果的 Levenshtein 字符距离，先统一全半角及大小写、去掉空白。另核对预先标记的 15 个关键字段。耗时是单次测量，初始化和逐图推理分开记录。

| OCR | 参考字符编辑数 | 关键字段 | 初始化 | 四张推理总耗时 |
| --- | --- | --- | --- | --- |
| PaddleOCR 3.3.3、PaddlePaddle 3.2.2、PP-OCRv5 mobile 检测/识别 | 0 / 141 | 15 / 15 | 18.506 秒 | 6.493 秒 |
| Tesseract 5.5.4、`tessdata_best` 简体中文 + 英文、稀疏文本模式 | 1 / 141 | 15 / 15 | 0.178 秒 | 0.777 秒 |

本样本优先按字符准确率选 PaddleOCR。两个引擎的关键字段得分相同，Tesseract 漏读暗色截图标题「导出清单」的「单」字，在这台机器上明显更快。这组样本不足以推断真实截图、其他字体或拍屏图片上的优劣。各引擎的输入、原始识别文本、检测框和逐图结果由 `tests/fixtures/field_ocr_benchmark.py` 保存。模型使用官方推理包。 [PaddleOCR](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html) · [Tesseract 语言模型](https://github.com/tesseract-ocr/tessdata_best) · [Tesseract 模式](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)

## 一场交流的实际归纳

以真实 PaddleOCR 识别四图，将识别文字和自然叙述笔记交给已连接的 Codex。笔记重复提到科室小结，同一段同时描述小结和导出要求。产出如下。

| 事项 | 截图证据 | 笔记证据 |
| --- | --- | --- |
| 已录入科室小结未显示在报告预览 | 截图 1 显示暂无内容，截图 2 显示示例内容已录入及已保存 | 第 1、2、4 行 |
| 导出清单新增最终审核时间 | 截图 3 显示当前导出字段 | 第 2 行说明要使用最终审核时间并保留审核人 |
| 刷新同步返回 504 且重试失败 | 截图 4 显示 504 与重试失败 | 第 3 行，影响范围待查 |

三条均包含笔记和截图，重复描述合为一条。模型保留「与同步失败是否有关尚不确定」和「纸质报告暂未验证」。服务端校验引用是否属于本场记录，从原材料回填原句和坐标。截图矩形基于解码并转换方向后的图像像素。隔离 HTTP 验收在审核前看到零条现场事件，批准一条后看到一个只读任务及原证据，未取得本轮分析时实施请求返回 409。真实模型结果在 `.test-tmp/field-organizer-live-r1/candidates.json`。

## 本地配置和复验

在项目目录单独安装 `requirements-field-ocr.txt`。配置 `SUPERAGENT_FIELD_OCR_PYTHON` 指向这套 Python。将官方 `PP-OCRv5_mobile_det_infer` 和 `PP-OCRv5_mobile_rec_infer` 解压到同一目录，设置 `SUPERAGENT_FIELD_OCR_MODELS` 指向该目录。默认引擎为 `paddle`，运行时只读本地模型。还需在工作台连接可用的本机 Codex。归纳阶段只提交本地提取的文字和现场笔记，原图在人工审核后按现有 Worker 附件流程使用。按量模型复用既有预算预留。

对照时在 OCR 环境另装 `tesserocr==2.13.0`，把 `chi_sim.traineddata` 与 `eng.traineddata` 放到模型根目录的 `tessdata` 子目录。两个引擎分别执行 `tests/fixtures/field_ocr_benchmark.py --engine paddle|tesseract --models <模型目录> --output <样本目录>`。真实归纳验收使用项目 Python 运行 `tests/fixtures/field_organizer_live.py <样本目录> <新证据目录>`，该脚本使用当前本机登录和单独数据库，输入仅为脚本生成的样本。

审核和实施均沿用原人工确认。OCR 和模型错误会明确返回，正常模式不使用模拟规则代替真实结果。截图无可识别文字且缺少笔记时，提示补充材料。当前只完成虚构样本验证，尚无真实医院截图或多场交流的质量结论。录音录屏没有进入本轮范围。

后端回归 31 项通过，前端构建成功。Edge 首轮在 1440×1000、390×844 复核本轮真实模型输出的渲染和模拟审核流程。截图显示窄屏连续铺开证据会推远审核操作，长内容也需要在短文本框内滚动。调整为逐项展开证据、加高长内容输入框后，1440×1000、1024×900、390×844 的 6 项复验均通过。两轮截图目录分别为 `.test-tmp/design-workflow-visual/2026-11-18T07-47-08-885Z/results/` 和 `.test-tmp/design-workflow-visual/2026-11-18T07-49-42-926Z/results/`。浏览器检查复用了保存的模型结果，实际 OCR 与 Codex 请求由独立 HTTP 验收执行。
