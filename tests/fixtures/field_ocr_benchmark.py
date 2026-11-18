"""Render fictional Chinese workstation samples and score both actual OCR engines."""
import argparse
import json
import os
from pathlib import Path
import sys
from time import perf_counter
import unicodedata

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from superagent.core.field_ocr import load_engine, recognize


SAMPLES = [
    ('preview', '报告预览', ['科室小结：暂无内容', '报告编号：DEMO-006', '状态：待审核'],
     ['科室小结', '暂无内容', 'DEMO-006', '待审核'], '#ffffff', '#233451', 22),
    ('detail', '科室详情', ['科室小结：示例内容已录入', '资料来源：模拟接口 v2', '状态：已保存'],
     ['示例内容已录入', '模拟接口', '已保存'], '#edf2f7', '#334155', 19),
    ('export', '导出清单', ['姓名 / 体检编号 / 审核人', '导出列：姓名、体检编号、审核人', '导出格式：Excel'],
     ['审核人', '体检编号', '导出格式', 'Excel'], '#152038', '#dfebf7', 16),
    ('sync', '同步提示', ['同步失败：接口返回 504', '已重试 2 次，仍未成功', '节点：TEST-GW'],
     ['同步失败', '504', '仍未成功', 'TEST-GW'], '#f4f5f6', '#657484', 14),
]

NOTES = ('验收会上又演示了一遍，详情里已经录入科室小结，但同一份报告的预览还是空白。\n'
         '这个先找原因，纸质报告暂未验证。导出清单希望新增审核时间，用最终审核的时间，原有审核人保留。\n'
         '后面操作又遇到一个现象：刷新同步时弹出 504，重试两次。暂不知道影响所有报告还是个别报告。\n'
         '回到前面那个科室小结问题，首次和刷新后都没显示，和同步失败是否有关还不确定。')


def normalize(text):
    return ''.join(char for char in unicodedata.normalize('NFKC', text).casefold() if not char.isspace())


def distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        row = [i]
        for j, b in enumerate(right, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = row
    return previous[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--engine', choices=['paddle', 'tesseract'], required=True)
    parser.add_argument('--font', type=Path, default=Path('C:/Windows/Fonts/msyh.ttc'))
    args = parser.parse_args()
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'notes.txt').write_text(NOTES, encoding='utf-8')
    for name, title, lines, _, background, color, size in SAMPLES:
        image = Image.new('RGB', (650, 240), background)
        draw = ImageDraw.Draw(image)
        draw.rectangle((12, 13, 637, 227), outline=color, width=1)
        draw.text((30, 24), title, fill=color, font=ImageFont.truetype(str(args.font), 27))
        draw.line((30, 68, 620, 68), fill=color, width=1)
        for offset, line in enumerate(lines):
            draw.text((36, 84 + offset * 40), line, fill=color, font=ImageFont.truetype(str(args.font), size))
        image.save(args.output / (name + '.png'))
    start = perf_counter()
    engine = load_engine(args.engine, args.models.resolve())
    startup = round(perf_counter() - start, 3)
    results = []
    for name, title, lines, anchors, *_ in SAMPLES:
        start = perf_counter()
        output = recognize(engine, args.output / (name + '.png'))
        seconds = round(perf_counter() - start, 3)
        expected = normalize(title + ''.join(lines))
        actual = normalize(''.join(row['text'] for row in output))
        results.append(dict(name=name, reference=[title, *lines], anchors=anchors,
                            missing=[anchor for anchor in anchors if normalize(anchor) not in actual],
                            edits=distance(expected, actual), characters=len(expected), seconds=seconds, lines=output))
    data = {'engine': args.engine, 'startup_seconds': startup, 'images': results}
    (args.output / f'{args.engine}.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: [row[key] for row in results] for key in ('name', 'edits', 'characters', 'missing', 'seconds')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
