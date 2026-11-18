"""Local OCR subprocess. Model files are provisioned explicitly by the operator."""
import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import sys


def _line(text, box, score):
    return {'text': text.strip(), 'box': [int(value) for value in box], 'confidence': round(float(score), 4)}


def load_engine(name, models):
    if name == 'paddle':
        from paddleocr import PaddleOCR

        configs = {stage: f'PP-OCRv5_mobile_{stage}' for stage in ('det', 'rec')}
        detection, recognition = [models / (configs[stage] + '_infer') for stage in ('det', 'rec')]
        for model in (detection, recognition):
            if not (model / 'inference.pdiparams').is_file():
                raise ValueError(f'Missing local model: {model.name}')
        ocr = PaddleOCR(device='cpu', enable_mkldnn=False, cpu_threads=4,
                        text_detection_model_name=configs['det'], text_detection_model_dir=str(detection),
                        text_recognition_model_name=configs['rec'], text_recognition_model_dir=str(recognition),
                        use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)

        def predict(image):
            import numpy as np

            output = ocr.predict(np.asarray(image)[:, :, ::-1].copy())[0]
            return [_line(text, box, score) for text, box, score in
                    zip(output['rec_texts'], output['rec_boxes'], output['rec_scores'], strict=True) if text.strip()]

        return predict

    if name != 'tesseract':
        raise ValueError('Unrecognized OCR engine')
    from tesserocr import PSM, RIL, PyTessBaseAPI, iterate_level

    api = PyTessBaseAPI(path=str(models / 'tessdata'), lang='chi_sim+eng', psm=PSM.SPARSE_TEXT)

    def predict(image):
        api.SetImage(image)
        api.Recognize()
        iterator = api.GetIterator()
        lines = []
        if iterator:
            for row in iterate_level(iterator, RIL.TEXTLINE):
                text = row.GetUTF8Text(RIL.TEXTLINE)
                if text and text.strip():
                    lines.append(_line(text, row.BoundingBox(RIL.TEXTLINE), row.Confidence(RIL.TEXTLINE) / 100))
        return lines

    return predict


def recognize(predict, path):
    from PIL import Image, ImageOps

    with Image.open(path) as source:
        if source.width * source.height > 16_000_000:
            raise ValueError('Image exceeds the 16 megapixel limit')
        image = ImageOps.exif_transpose(source).convert('RGB')
    lines = predict(image)
    return sorted(lines, key=lambda line: (line['box'][1], line['box'][0]))


def main():
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--engine', choices=['paddle', 'tesseract'], required=True)
    parser.add_argument('pictures', type=Path, nargs='+')
    args = parser.parse_args()
    with redirect_stdout(sys.stderr):
        engine = load_engine(args.engine, args.models)
        results = [recognize(engine, path) for path in args.pictures]
    print(json.dumps(results, ensure_ascii=True))


if __name__ == '__main__':
    main()
