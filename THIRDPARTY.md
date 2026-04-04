# Third-Party Licenses

This software incorporates the following third-party components.

---

## whisper.cpp

- **Repository**: https://github.com/ggerganov/whisper.cpp
- **Version used**: v1.7.4

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- **Source**: OpenAI's Whisper model weights converted to GGML format  
  https://huggingface.co/ggerganov/whisper.cpp

---

## llama.cpp

- **Repository**: https://github.com/ggerganov/llama.cpp
- **Version used**: b5192

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Models (downloaded at runtime)

以下のモデルはユーザーの指示に従い実行時に自動ダウンロードされます。  
ソフトウェアに同梱はされませんが、利用に際しては各ライセンスをご確認ください。

### OpenAI Whisper (音声認識モデル)

- **配布元**: https://huggingface.co/ggerganov/whisper.cpp (ggml 変換版)
- **ライセンス**: MIT License
- **著作権**: Copyright (c) OpenAI

### Qwen2.5-7B / 14B-Instruct (Alibaba Cloud / Qwen Team)

- **配布元**: https://huggingface.co/Qwen/
- **ライセンス**: Apache License 2.0
- **著作権**: Copyright (c) Alibaba Cloud

> **Note**: Qwen2.5-3B は Qwen Research License（非商用専用）のため、
> このプロジェクトのモデルレジストリには含まれていません。

### Qwen3 0.6B〜8B / Qwen3.5 0.8B〜9B (Alibaba Cloud / Qwen Team, Unsloth GGUF)

- **配布元**: https://huggingface.co/unsloth/ (Unsloth による GGUF 量子化版)
- **ライセンス**: Apache License 2.0
- **著作権**: Copyright (c) Alibaba Cloud

### Gemma 4 E2B / E4B / 26B (Google LLC, bartowski GGUF)

- **配布元**: https://huggingface.co/bartowski/ (bartowski による GGUF 量子化版)
- **ライセンス**: Apache License 2.0
- **著作権**: Copyright (c) Google LLC
- **備考**: Gemma 4 (2026年4月〜) は Apache 2.0 が適用されます。旧来の Gemma カスタムライセンスから変更されています。
