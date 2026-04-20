#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
import wave
from contextlib import redirect_stdout
from dataclasses import replace

import numpy as np


SENSEVOICE_LANG_RE = re.compile(r"<\|(zh|en|yue|ja|ko|nospeech)\|>")

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


def normalize_sensevoice_language(language):
    language = (language or "").strip().lower()
    if language in {"zh", "en", "yue", "ja", "ko", "nospeech"}:
        return language
    return "auto"


def normalize_whisperx_language(language):
    language = (language or "").strip().lower()
    return language or None


def detect_sensevoice_language(raw_text, fallback):
    match = SENSEVOICE_LANG_RE.search(raw_text or "")
    if match:
        return match.group(1)
    fallback = (fallback or "").strip().lower()
    return "" if fallback == "auto" else fallback


def load_wav_float32(audio_path):
    with wave.open(audio_path, "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    if sample_width == 2:
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sample_width == 4:
        audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError(f"unsupported WAV sample width: {sample_width}")

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if sample_rate != 16000:
        audio = resample_audio(audio, sample_rate, 16000)

    return audio


def resample_audio(audio, sample_rate, target_rate):
    if sample_rate == target_rate or len(audio) == 0:
        return audio.astype(np.float32)

    duration = len(audio) / float(sample_rate)
    target_length = max(1, int(round(duration * target_rate)))
    x_old = np.linspace(0.0, duration, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, duration, num=target_length, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


class SenseVoiceBackend:
    def __init__(self, model_ref, device):
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import rich_transcription_postprocess

        self._postprocess = rich_transcription_postprocess
        self._model = AutoModel(
            model=model_ref,
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
            device=device,
        )

    def transcribe(self, audio_path, language, prompt):
        del prompt
        sensevoice_lang = normalize_sensevoice_language(language)
        result = self._model.generate(
            input=audio_path,
            cache={},
            language=sensevoice_lang,
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
            merge_length_s=15,
        )
        raw_text = ""
        if isinstance(result, list) and result and isinstance(result[0], dict):
            raw_text = result[0].get("text", "")
        detected = detect_sensevoice_language(raw_text, sensevoice_lang)
        return self._postprocess(raw_text).strip(), detected


class WhisperXBackend:
    def __init__(self, model_ref, device):
        import whisperx

        compute_type = "int8" if device == "cpu" else "float16"
        self._model = whisperx.load_model(
            model_ref,
            device=device,
            compute_type=compute_type,
            vad_method="silero",
            asr_options={"condition_on_previous_text": False},
        )

    def transcribe(self, audio_path, language, prompt):
        whisperx_lang = normalize_whisperx_language(language)
        self._model.options = replace(self._model.options, initial_prompt=(prompt or None))
        audio = load_wav_float32(audio_path)
        result = self._model.transcribe(audio, batch_size=8, language=whisperx_lang)
        text = "".join(segment.get("text", "") for segment in result.get("segments", [])).strip()
        detected = result.get("language") or (whisperx_lang or "")
        return text, detected


def build_backend(args):
    if args.backend == "sensevoice":
        return SenseVoiceBackend(args.model, args.device)
    if args.backend == "whisperx":
        return WhisperXBackend(args.model, args.device)
    raise RuntimeError(f"unsupported backend: {args.backend}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--requirements-path", default="")
    args = parser.parse_args()

    try:
        with redirect_stdout(sys.stderr):
            backend = build_backend(args)
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
                text, detected_language = backend.transcribe(
                    request["audio_path"],
                    request.get("language", ""),
                    request.get("prompt", ""),
                )
            emit({
                "status": "ok",
                "text": text,
                "detected_language": detected_language,
            })
        except Exception as exc:
            emit(install_error(exc, args.requirements_path))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
