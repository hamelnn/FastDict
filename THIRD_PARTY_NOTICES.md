# Third-party OCR assets

FastLingo packages [Tesseract.js](https://github.com/naptha/tesseract.js), [Tesseract.js Core](https://github.com/naptha/tesseract.js-core), and English, simplified/traditional Chinese, Japanese and Korean models from [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast). These projects and models are distributed under Apache License 2.0. The asset preparation script includes license copies in the built application under `ocr/`.

Images are processed on-device. OCR assets are downloaded during development/build preparation and are loaded locally by the installed application.

The browser OCR adapter in `src/lib/ocrWorker.ts` implements the message protocol of the bundled Tesseract.js 6.0.1 worker. It retains direct ownership of the underlying browser Worker during model initialization so failed or cancelled operations can terminate it. The bundled worker, core, models and their Apache 2.0 license copies remain included.
