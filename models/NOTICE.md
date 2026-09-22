# 모델 파일 출처 · 라이선스

| 파일 | 내용 | 출처 | 라이선스 |
|---|---|---|---|
| `det.onnx` | PaddleOCR PP-OCRv5 글줄 검출(DB) | PaddlePaddle/PaddleOCR — ONNX 변환본은 jingsongliujing/OnnxOCR 3.1.0 | Apache-2.0 |
| `cls.onnx` | PaddleOCR 글줄 방향 분류(0° / 180°) | 같음 | Apache-2.0 |

두 모델은 언어와 무관하게 글줄 위치와 방향만 찾는다. 글자 읽기는 Tesseract.js(kor + eng, Apache-2.0)가 한다.
