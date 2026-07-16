"""
transcribe_worker.py
====================
Hebrew transcription worker using faster-whisper with ivrit-ai models.
Outputs subtitles in SRT format.

Packaging to EXE (PyInstaller):
    pyinstaller --onefile --name transcribe_worker transcribe_worker.py

Dependencies:
    pip install faster-whisper

CUDA Setup:
    ─────────────────────────────────────────────────────────────────
    Set CUDA_DIR below to your CUDA installation root.
    Example paths:
        Windows : C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.2
        Linux   : /usr/local/cuda-12.2

    The script will prepend the CUDA bin + lib directories to PATH /
    LD_LIBRARY_PATH so faster-whisper finds cuBLAS / cuDNN even when
    they are not on the system PATH.
    ─────────────────────────────────────────────────────────────────
"""

import argparse
import os
import sys
import textwrap
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
        print(f"[WARNING] CUDA directory not found: {cuda_dir}", file=sys.stderr)
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


# Configure CUDA before importing faster-whisper (which loads CuDNN at import)
_configure_cuda(CUDA_DIR)

try:
    from faster_whisper import WhisperModel
except ImportError:
    print(
        "[ERROR] faster-whisper is not installed.\n"
        "        Run:  pip install faster-whisper",
        file=sys.stderr,
    )
    sys.exit(1)


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
                # textwrap respects word boundaries
                wrapped = textwrap.wrap(line, width=max_chars)
                char_lines.extend(wrapped if wrapped else [line])
        return char_lines

    return word_lines


def _segments_to_srt(
    segments,
    max_words: int | None,
    max_chars: int | None,
) -> str:
    """Convert faster-whisper segment iterable to SRT string.

    All wrapped lines of a single segment are joined into ONE SRT block
    (multi-line text under a single timestamp), so only one subtitle
    is ever shown at a time.
    """
    blocks = []
    index = 1

    for segment in segments:
        lines = _wrap_text(segment.text, max_words, max_chars)
        start_ts = _format_timestamp(segment.start)
        end_ts = _format_timestamp(segment.end)
        # Join all lines into a single SRT block — never split by time
        block_text = "\n".join(lines)
        blocks.append(f"{index}\n{start_ts} --> {end_ts}\n{block_text}")
        index += 1

    return "\n\n".join(blocks) + "\n"


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
        print(f"[ERROR] Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    # Resolve compute type based on device
    compute_type = "float16" if device == "cuda" else "int8"

    print(f"[INFO] Loading model  : {model_name}")
    print(f"[INFO] Device         : {device}  ({compute_type})")
    if model_dir:
        print(f"[INFO] Model cache dir: {model_dir}")

    load_kwargs: dict = dict(
        model_size_or_path=model_name,
        device=device,
        compute_type=compute_type,
    )
    if model_dir:
        load_kwargs["download_root"] = model_dir

    model = WhisperModel(**load_kwargs)

    print(f"[INFO] Transcribing   : {audio_path}")
    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=5,
        vad_filter=True,           # voice-activity detection to skip silence
        vad_parameters=dict(
            min_silence_duration_ms=500
        ),
    )

    print(
        f"[INFO] Detected language: {info.language} "
        f"(prob={info.language_probability:.2f})"
    )

    srt_content = _segments_to_srt(segments, max_words_per_line, max_chars_per_line)

    out_path = Path(srt_out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(srt_content, encoding="utf-8")

    print(f"[INFO] SRT saved to   : {out_path}")


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
            Examples:
              # GPU, ivrit-turbo, max 8 words per line
              transcribe_worker audio.mp3 subtitles.srt \\
                  --model ivrit-ai/whisper-large-v3-turbo-ct2 \\
                  --device cuda \\
                  --max-words-per-line 8

              # CPU, custom model dir, 42 chars per line
              transcribe_worker audio.wav out/subs.srt \\
                  --model ivrit-ai/whisper-large-v3-turbo-ct2 \\
                  --model-dir D:/models \\
                  --device cpu \\
                  --max-chars-per-line 42
            """
        ),
    )

    parser.add_argument(
        "audio_path",
        help="Path to the input audio/video file.",
    )
    parser.add_argument(
        "srt_out_path",
        help="Path where the output .srt file will be written.",
    )
    parser.add_argument(
        "--language",
        default="he",
        metavar="LANG",
        help="Language code for transcription (default: 'he' for Hebrew).",
    )
    parser.add_argument(
        "--model",
        default="ivrit-ai/whisper-large-v3-turbo-ct2",
        metavar="MODEL",
        help=(
            "Model identifier — Hugging Face repo or local path.\n"
            "Default: ivrit-ai/whisper-large-v3-turbo-ct2\n"
            "Other ivrit-ai options:\n"
            "  ivrit-ai/faster-whisper-v2-d4\n"
            "  ivrit-ai/faster-distil-whisper-v2\n"
            "  ivrit-ai/whisper-v2-d3-e3"
        ),
    )
    parser.add_argument(
        "--model-dir",
        default=None,
        metavar="DIR",
        help=(
            "Directory where models are cached/downloaded.\n"
            "Defaults to the faster-whisper default (~/.cache/huggingface)."
        ),
    )
    parser.add_argument(
        "--device",
        choices=["cuda", "cpu"],
        default="cuda",
        help="Compute device: 'cuda' (GPU) or 'cpu'. Default: cuda.",
    )
    parser.add_argument(
        "--max-words-per-line",
        type=int,
        default=None,
        metavar="N",
        help="Maximum number of words per SRT line. Omit to disable word wrapping.",
    )
    parser.add_argument(
        "--max-chars-per-line",
        type=int,
        default=None,
        metavar="N",
        help="Maximum characters per SRT line. Omit to disable char wrapping.",
    )

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
