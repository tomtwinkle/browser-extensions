#!/usr/bin/env python3

import argparse
import json
import os
import sys
from contextlib import redirect_stdout

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def emit(payload):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def install_error(exc, requirements_path):
    message = str(exc).strip() or exc.__class__.__name__
    return {
        "status": "error",
        "error": message,
        "requirements_path": requirements_path,
    }


class MLXBackend:
    def __init__(self, model_ref):
        from mlx_lm import generate, load

        self._generate = generate
        self._model, self._tokenizer = load(model_ref)
        try:
            from mlx_lm.sample_utils import make_sampler
        except ImportError:
            make_sampler = None
        self._make_sampler = make_sampler

    def generate(self, prompt, max_tokens, temperature):
        kwargs = {
            "model": self._model,
            "tokenizer": self._tokenizer,
            "prompt": prompt,
            "max_tokens": max_tokens,
            "verbose": False,
        }
        if self._make_sampler is not None and temperature > 0:
            kwargs["sampler"] = self._make_sampler(temp=temperature)
            try:
                return str(self._generate(**kwargs)).strip()
            except TypeError:
                kwargs.pop("sampler", None)
        return str(self._generate(**kwargs, temp=temperature)).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--requirements-path", default="")
    args = parser.parse_args()

    try:
        with redirect_stdout(sys.stderr):
            backend = MLXBackend(args.model)
    except Exception as exc:
        emit(install_error(exc, args.requirements_path))
        return 1

    emit({"status": "ready", "requirements_path": args.requirements_path})

    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        if request.get("action") == "shutdown":
            emit({"status": "ok"})
            return 0

        try:
            with redirect_stdout(sys.stderr):
                text = backend.generate(
                    request.get("prompt", ""),
                    int(request.get("max_tokens", 512)),
                    float(request.get("temperature", 0.1)),
                )
            emit({
                "status": "ok",
                "text": text,
            })
        except Exception as exc:
            emit(install_error(exc, args.requirements_path))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
