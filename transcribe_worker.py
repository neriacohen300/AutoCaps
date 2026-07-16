"""
transcribe_worker.py
====================
Hebrew transcription worker using faster-whisper with ivrit-ai models.
Outputs subtitles in SRT format.

Packaging to EXE (PyInstaller):
    pyinstaller --onefile --name transcribe_worker transcribe_worker.py

Dependencies:
    pip install faster-whisper

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STDOUT  →  Newline-delimited JSON (NDJSON) progress events
           Parse these in the Premiere Pro extension.

STDERR  →  Human-readable log lines (prefixed [INFO] / [WARNING] / [ERROR])
           Safe to display in a console or discard.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Progress event shapes
─────────────────────
{ "event": "init",
  "audio_duration": 123.4 }          ← total audio length in seconds

{ "event": "loading_model",
  "model": "ivrit-ai/..." }

{ "event": "transcribing" }          ← model ready, transcription started

{ "event": "segment",
  "index": 5,
  "start": 12.34,                    ← segment start time (seconds)
  "end":   14.56,                    ← segment end time (seconds)
  "text":  "שלום עולם",
  "progress_pct": 42.1,              ← % of audio covered so far
  "elapsed_sec": 8.2,                ← wall-clock seconds since start
  "eta_sec": 11.3 }                  ← estimated seconds remaining

{ "event": "done",
  "subtitle_count": 87,
  "elapsed_sec": 19.6,
  "srt_path": "C:/out/subs.srt" }

{ "event": "error",
  "message": "Audio file not found" }

CUDA Setup:
    ─────────────────────────────────────────────────────────────────
    Set CUDA_DIR below to your CUDA installation root.
    Example paths:
        Windows : C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.2
        Linux   : /usr/local/cuda-12.2

    The script prepends CUDA bin + lib directories to PATH /
    LD_LIBRARY_PATH so faster-whisper finds cuBLAS / cuDNN even when
    they are not on the system PATH.
    ─────────────────────────────────────────────────────────────────
"""

import argparse
import json
import os
import sys
import textwrap
import time
from datetime import timedelta
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# CUDA PATH CONFIGURATION
# Change CUDA_DIR to match your installation.
# Set to None to skip (relies on system PATH instead).
# ──────────────────────────────────────────────────────────────────────────────
CUDA_DIR = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.2"  # <── EDIT ME


def _configure_cuda(cuda_dir: str | None) -> None:
    """Prepend CUDA bin/lib paths so CuBLAS/CuDNN are discoverable."""
    if not cuda_dir:
        return
    cuda_path = Path(cuda_dir)
    if not cuda_path.exists():
        _log(f"CUDA directory not found: {cuda_dir}", level="WARNING")
        return

    if sys.platform == "win32":
        bin_dir = str(cuda_path / "bin")
        lib_dir = str(cuda_path / "lib" / "x64")
        current = os.environ.get("PATH", "")
        os.environ["PATH"] = bin_dir + os.pathsep + lib_dir + os.pathsep + current
    else:
        bin_dir = str(cuda_path / "bin")
        lib_dir = str(cuda_path / "lib64")
        current_path = os.environ.get("PATH", "")
        os.environ["PATH"] = bin_dir + os.pathsep + current_path
        current_ld = os.environ.get("LD_LIBRARY_PATH", "")
        os.environ["LD_LIBRARY_PATH"] = lib_dir + os.pathsep + current_ld


# ──────────────────────────────────────────────────────────────────────────────
# Logging / progress helpers
# ──────────────────────────────────────────────────────────────────────────────

def _log(message: str, level: str = "INFO") -> None:
    """Write a human-readable line to stderr."""
    print(f"[{level}] {message}", file=sys.stderr, flush=True)


def _emit(event: dict) -> None:
    """Write a JSON progress event to stdout (one line = one event)."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _get_audio_duration(audio_path: Path) -> float | None:
    """
    Best-effort audio duration in seconds without heavy dependencies.
    Uses ffprobe if available; falls back to None so the extension
    can still show elapsed time / subtitle count without a percentage.
    """
    import shutil, subprocess
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        result = subprocess.run(
            [
                ffprobe, "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            capture_output=True, text=True, timeout=15,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# SRT helpers
# ──────────────────────────────────────────────────────────────────────────────

def _format_timestamp(seconds: float) -> str:
    """Convert seconds to SRT timestamp: HH:MM:SS,mmm"""
    td = timedelta(seconds=seconds)
    total_seconds = int(td.total_seconds())
    millis = int(round((td.total_seconds() - total_seconds) * 1000))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def _wrap_text(text: str, max_words: int | None, max_chars: int | None) -> list[str]:
    """
    Split a segment's text into display lines respecting max_words and/or
    max_chars constraints. Returns a list of lines for one SRT block.
    """
    text = text.strip()
    if not text:
        return [""]

    # 1. Split by word count first (if requested)
    if max_words:
        words = text.split()
        word_lines = []
        for i in range(0, len(words), max_words):
            word_lines.append(" ".join(words[i : i + max_words]))
    else:
        word_lines = [text]

    # 2. Optionally further split each word-line by character count
    if max_chars:
        char_lines = []
        for line in word_lines:
            if len(line) <= max_chars:
                char_lines.append(line)
            else:
                wrapped = textwrap.wrap(line, width=max_chars)
                char_lines.extend(wrapped if wrapped else [line])
        return char_lines

    return word_lines


# ──────────────────────────────────────────────────────────────────────────────
# Core transcription
# ──────────────────────────────────────────────────────────────────────────────

def transcribe(
    audio_path: str,
    srt_out_path: str,
    language: str,
    model_name: str,
    model_dir: str | None,
    device: str,
    max_words_per_line: int | None,
    max_chars_per_line: int | None,
) -> None:
    audio_path = Path(audio_path)
    if not audio_path.exists():
        _emit({"event": "error", "message": f"Audio file not found: {audio_path}"})
        _log(f"Audio file not found: {audio_path}", "ERROR")
        sys.exit(1)

    # ── Probe duration ────────────────────────────────────────────────────────
    audio_duration = _get_audio_duration(audio_path)
    _emit({"event": "init", "audio_duration": audio_duration})
    if audio_duration:
        _log(f"Audio duration : {audio_duration:.1f}s")
    else:
        _log("Audio duration : unknown (ffprobe not found — % progress unavailable)")

    # ── Load model ────────────────────────────────────────────────────────────
    compute_type = "float16" if device == "cuda" else "int8"
    _emit({"event": "loading_model", "model": model_name, "device": device})
    _log(f"Loading model  : {model_name}")
    _log(f"Device         : {device}  ({compute_type})")
    if model_dir:
        _log(f"Model cache dir: {model_dir}")

    load_kwargs: dict = dict(
        model_size_or_path=model_name,
        device=device,
        compute_type=compute_type,
    )
    if model_dir:
        load_kwargs["download_root"] = model_dir

    model = WhisperModel(**load_kwargs)

    # ── Transcribe ────────────────────────────────────────────────────────────
    _emit({"event": "transcribing"})
    _log(f"Transcribing   : {audio_path}")

    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    _log(
        f"Detected language: {info.language} "
        f"(prob={info.language_probability:.2f})"
    )

    # ── Consume segments, emit progress, build SRT ────────────────────────────
    srt_blocks: list[str] = []
    segment_index = 0
    t_start = time.monotonic()

    for segment in segments_iter:
        segment_index += 1
        elapsed = time.monotonic() - t_start

        # Progress % — based on end timestamp of this segment vs total duration
        if audio_duration and audio_duration > 0:
            progress_pct = min(segment.end / audio_duration * 100, 100.0)
            # ETA: if we've done X% in elapsed seconds, total ≈ elapsed / (X/100)
            if progress_pct > 0:
                eta_sec = max(0.0, elapsed / (progress_pct / 100) - elapsed)
            else:
                eta_sec = None
        else:
            progress_pct = None
            eta_sec = None

        _emit({
            "event":        "segment",
            "index":        segment_index,
            "start":        round(segment.start, 3),
            "end":          round(segment.end, 3),
            "text":         segment.text.strip(),
            "progress_pct": round(progress_pct, 1) if progress_pct is not None else None,
            "elapsed_sec":  round(elapsed, 1),
            "eta_sec":      round(eta_sec, 1) if eta_sec is not None else None,
        })

        # Build SRT block
        lines = _wrap_text(segment.text, max_words_per_line, max_chars_per_line)
        start_ts = _format_timestamp(segment.start)
        end_ts   = _format_timestamp(segment.end)
        block_text = "\n".join(lines)
        srt_blocks.append(f"{segment_index}\n{start_ts} --> {end_ts}\n{block_text}")

    # ── Write SRT ─────────────────────────────────────────────────────────────
    out_path = Path(srt_out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    srt_content = "\n\n".join(srt_blocks) + "\n"
    out_path.write_text(srt_content, encoding="utf-8")

    elapsed_total = round(time.monotonic() - t_start, 1)
    _emit({
        "event":          "done",
        "subtitle_count": segment_index,
        "elapsed_sec":    elapsed_total,
        "srt_path":       str(out_path.resolve()),
    })
    _log(f"Done — {segment_index} subtitles in {elapsed_total}s → {out_path}")


# ──────────────────────────────────────────────────────────────────────────────
# Startup — configure CUDA before importing faster-whisper
# ──────────────────────────────────────────────────────────────────────────────

_configure_cuda(CUDA_DIR)

try:
    from faster_whisper import WhisperModel
except ImportError:
    _emit({"event": "error", "message": "faster-whisper is not installed. Run: pip install faster-whisper"})
    _log("faster-whisper is not installed. Run: pip install faster-whisper", "ERROR")
    sys.exit(1)


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="transcribe_worker",
        description="Hebrew transcription via faster-whisper + ivrit-ai models → SRT",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """\
            Stdout emits newline-delimited JSON progress events.
            Stderr emits human-readable log lines.

            Examples:
              transcribe_worker audio.mp3 subtitles.srt \\
                  --model ivrit-ai/whisper-large-v3-turbo-ct2 \\
                  --device cuda --max-words-per-line 8

              transcribe_worker audio.wav out/subs.srt \\
                  --model ivrit-ai/whisper-large-v3-turbo-ct2 \\
                  --model-dir D:/models --device cpu \\
                  --max-chars-per-line 42
            """
        ),
    )
    parser.add_argument("audio_path",    help="Path to the input audio/video file.")
    parser.add_argument("srt_out_path",  help="Path where the output .srt file will be written.")
    parser.add_argument("--language",    default="he",  metavar="LANG",
                        help="Language code (default: 'he').")
    parser.add_argument("--model",       default="ivrit-ai/whisper-large-v3-turbo-ct2", metavar="MODEL",
                        help="HuggingFace repo or local model path.")
    parser.add_argument("--model-dir",   default=None, metavar="DIR",
                        help="Directory to cache / load models from.")
    parser.add_argument("--device",      choices=["cuda", "cpu"], default="cuda",
                        help="Compute device (default: cuda).")
    parser.add_argument("--max-words-per-line", type=int, default=None, metavar="N",
                        help="Max words per SRT display line.")
    parser.add_argument("--max-chars-per-line", type=int, default=None, metavar="N",
                        help="Max characters per SRT display line.")
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    transcribe(
        audio_path=args.audio_path,
        srt_out_path=args.srt_out_path,
        language=args.language,
        model_name=args.model,
        model_dir=args.model_dir,
        device=args.device,
        max_words_per_line=args.max_words_per_line,
        max_chars_per_line=args.max_chars_per_line,
    )


if __name__ == "__main__":
    main()
