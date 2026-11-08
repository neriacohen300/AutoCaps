"""
transcribe_worker.py
====================
Hebrew transcription worker using faster-whisper with ivrit-ai models.
Outputs subtitles in SRT format.

Packaging to EXE (PyInstaller):
    pyinstaller --onefile --name transcribe_worker transcribe_worker.py

Dependencies:
    pip install faster-whisper

STDOUT  ->  Newline-delimited JSON (NDJSON) progress events
            Parse these in the Premiere Pro extension.

STDERR  ->  Human-readable log lines (prefixed [INFO] / [WARNING] / [ERROR])

Progress event shapes
---------------------
{ "event": "init", "audio_duration": 123.4 }
{ "event": "loading_model", "model": "ivrit-ai/...", "device": "cuda" }
{ "event": "transcribing" }
{ "event": "segment", "index": 5, "start": 12.34, "end": 14.56,
  "text": "שלום עולם", "progress_pct": 42.1, "elapsed_sec": 8.2, "eta_sec": 11.3 }
{ "event": "done", "subtitle_count": 87, "elapsed_sec": 19.6, "srt_path": "C:/out/subs.srt" }
{ "event": "error", "message": "Audio file not found" }

CUDA Setup:
    The CUDA directory is taken from the CUDA_DIR environment variable
    (sent by the Premiere Pro extension). The script prepends CUDA bin + lib
    directories to PATH / LD_LIBRARY_PATH so faster-whisper finds cuBLAS /
    cuDNN even when they are not on the system PATH.
"""

import argparse
import json
import os
import re
import sys
import textwrap
import time
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# CUDA PATH CONFIGURATION
# ──────────────────────────────────────────────────────────────────────────────
CUDA_DIR = os.environ.get("CUDA_DIR", None)


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
        # Python 3.8+ on Windows ignores PATH for DLL loading of extension
        # modules, so register the directories explicitly as well.
        for d in (bin_dir, lib_dir):
            try:
                os.add_dll_directory(d)
            except (AttributeError, OSError):
                pass
    else:
        bin_dir = str(cuda_path / "bin")
        lib_dir = str(cuda_path / "lib64")
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
        os.environ["LD_LIBRARY_PATH"] = lib_dir + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")


# ──────────────────────────────────────────────────────────────────────────────
# Logging / progress helpers
# ──────────────────────────────────────────────────────────────────────────────

def _log(message: str, level: str = "INFO") -> None:
    """Write a human-readable line to stderr."""
    print(f"[{level}] {message}", file=sys.stderr, flush=True)


def _emit(event: dict) -> None:
    """Write a JSON progress event to stdout (one line = one event)."""
    sys.stdout.buffer.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def _get_audio_duration(audio_path: Path) -> float | None:
    """Best-effort audio duration in seconds via ffprobe (None if unavailable)."""
    import shutil
    import subprocess
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
    total_ms = max(0, int(round(seconds * 1000)))
    total_seconds, millis = divmod(total_ms, 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


# ── Trailing punctuation policy ───────────────────────────────────────────────
# A subtitle block must NEVER end with a period (or comma / ellipsis / sof-pasuq).
# Question marks and exclamation marks are kept. Stripping is applied at
# several stages (cue text, every wrapped block, and a final safety net right
# before writing to disk), so no code path can leak a trailing period.
_TRAILING_STRIP_CHARS = ".,،、…。׃"
_INVISIBLE_CHARS = "\u200e\u200f\u200b\u202a\u202b\u202c\u2066\u2067\u2068\u2069 \t"


def _strip_trailing_punct(text: str) -> str:
    """Remove any trailing periods / commas / ellipses (and stray whitespace
    or invisible bidi marks around them) from the end of a subtitle text."""
    return text.rstrip(_TRAILING_STRIP_CHARS + _INVISIBLE_CHARS)


def _wrap_text(text: str, max_words: int | None, max_chars: int | None) -> list[str]:
    """Split a segment's text into display lines respecting max_words / max_chars."""
    text = text.strip()
    if not text:
        return [""]

    if max_words:
        words = text.split()
        word_lines = [" ".join(words[i: i + max_words]) for i in range(0, len(words), max_words)]
    else:
        word_lines = [text]

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


def _chunk_lines(lines: list[str], max_lines: int | None) -> list[list[str]]:
    """Group display lines into chunks of at most max_lines lines each."""
    if not max_lines or max_lines <= 0:
        return [lines]
    return [lines[i: i + max_lines] for i in range(0, len(lines), max_lines)] or [lines]


# ──────────────────────────────────────────────────────────────────────────────
# Word-level cue grouping
# ──────────────────────────────────────────────────────────────────────────────

_SENTENCE_END_CHARS = set(".?!:;׃…")


# ──────────────────────────────────────────────────────────────────────────────
# Hebrew / bidi text sanitizer
#
# Premiere's caption renderer defaults to LTR and honors explicit directional
# isolates (LRI/RLI ... PDI) but not bare neutral marks. So:
#   1. embedded Latin runs are wrapped in LRI...PDI,
#   2. the whole Hebrew line is wrapped in RLI...PDI,
#   3. ASCII quotes in Hebrew acronyms become gershayim / geresh.
# Applied once, on the final display lines, right before writing the SRT.
# ──────────────────────────────────────────────────────────────────────────────

_LRI = "\u2066"
_RLI = "\u2067"
_PDI = "\u2069"

_HEBREW_RANGE = "\u0590-\u05FF\uFB1D-\uFB4F"
_HEBREW_CHAR_RE = re.compile(f"[{_HEBREW_RANGE}]")
_LATIN_RUN_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._\-/@:+#]*[A-Za-z0-9])?")
_GERSHAYIM_RE = re.compile(f'([{_HEBREW_RANGE}])"([{_HEBREW_RANGE}])')
_GERESH_RE = re.compile(f"([{_HEBREW_RANGE}])'(?=[{_HEBREW_RANGE}]|\\B|$)")


def _fix_hebrew_acronym_quotes(text: str) -> str:
    prev = None
    while prev != text:
        prev = text
        text = _GERSHAYIM_RE.sub("\\1\u05F4\\2", text)
        text = _GERESH_RE.sub("\\1\u05F3", text)
    return text


def _isolate_embedded_latin(text: str) -> str:
    if not _HEBREW_CHAR_RE.search(text):
        return text
    return _LATIN_RUN_RE.sub(lambda m: f"{_LRI}{m.group(0)}{_PDI}", text)


def _force_rtl_paragraph(text: str) -> str:
    if not _HEBREW_CHAR_RE.search(text):
        return text
    return f"{_RLI}{text}{_PDI}"


def sanitize_rtl_text(text: str) -> str:
    """Full Hebrew/bidi cleanup for one display line."""
    if not text:
        return text
    text = _fix_hebrew_acronym_quotes(text)
    text = _isolate_embedded_latin(text)
    text = _force_rtl_paragraph(text)
    return text


def _flatten_words(segment) -> list[dict]:
    """
    Pull per-word timestamps out of a faster-whisper segment. Falls back to a
    single "word" if word timestamps weren't produced. Every word carries
    "seg_end" so the last cue of a segment can end at the segment's end.
    """
    words_out: list[dict] = []
    seg_words = getattr(segment, "words", None) or []
    if seg_words:
        last_idx = len(seg_words) - 1
        for i, w in enumerate(seg_words):
            text = (w.word or "").strip()
            if not text:
                continue
            words_out.append({
                "text": text,
                "start": w.start,
                "end": w.end,
                "segment_boundary": i == last_idx,
                "seg_end": segment.end,
            })
        # If the very last word was empty, make sure the segment still closes.
        if words_out:
            words_out[-1]["segment_boundary"] = True
    else:
        text = segment.text.strip()
        if text:
            words_out.append({
                "text": text,
                "start": segment.start,
                "end": segment.end,
                "segment_boundary": True,
                "seg_end": segment.end,
            })
    return words_out


def _tighten_word_timings(words: list[dict]) -> list[dict]:
    """
    Whisper's first word after a silence is often stretched backwards into
    the silence. Cap its duration to a plausible value and pull the START
    forward. Word END times are deliberately never shortened.
    """
    prev_end = None
    for w in words:
        s, e = w["start"], w["end"]
        if s is None or e is None:
            continue
        n_chars = max(len(w["text"]), 1)
        max_dur = 0.30 + 0.09 * n_chars
        if e - s > max_dur:
            gap_before = (s - prev_end) if prev_end is not None else 1.0
            if gap_before >= 0.25:
                w["start"] = e - max_dur
        prev_end = w["end"]
    return words


def _group_words_into_cues(
    words: list[dict],
    max_words_per_cue: int | None,
    silence_gap_sec: float,
) -> list[list[dict]]:
    """
    Split the word stream into cues. A boundary is drawn when: the word cap
    is reached, the word ends a sentence, the word closes its whisper
    segment, or the pause before the next word exceeds silence_gap_sec.
    """
    cues: list[list[dict]] = []
    current: list[dict] = []
    n = len(words)

    for i, word in enumerate(words):
        current.append(word)

        boundary = bool(max_words_per_cue) and len(current) >= max_words_per_cue
        if not boundary and word["segment_boundary"]:
            boundary = True
        if not boundary and word["text"] and word["text"][-1] in _SENTENCE_END_CHARS:
            boundary = True
        if not boundary and i + 1 < n:
            nxt = words[i + 1]
            if word["end"] is not None and nxt["start"] is not None:
                if nxt["start"] - word["end"] > silence_gap_sec:
                    boundary = True

        if boundary:
            cues.append(current)
            current = []

    if current:
        cues.append(current)
    return cues


def _clean_punctuation(text: str) -> str:
    """
    הסרת סימני פיסוק מהמילים. משאירה גרשיים וגרש פנימיים של קיצורים בעברית
    (צה"ל, ד"ר) ומסירה מירכאות חיצוניות המקיפות את המילה.
    """
    to_remove = '.?!:;׃…,،()[]{}' + '/<>=-+*&^%$#@~`|\\_–—'
    table = str.maketrans("", "", to_remove)
    text = text.translate(table)
    text = text.strip('\'"')
    return text


def _cues_to_timed_entries(
    cues: list[list[dict]],
    min_display_sec: float,
    remove_punctuation: bool = False,
    timing_offset: float = 0.0,
    end_padding: float = 0.15,
) -> list[tuple[float, float, str]]:
    """
    Turn word cues into (start, end, text) triples.

      - start is always the real start of the first word
      - a cue closing a whisper segment ends at the segment end
      - end_padding is added to every cue's end
      - short cues are extended up to min_display_sec but never overlap the next cue
      - if the previous cue overlaps, the PREVIOUS cue is trimmed
      - a cue NEVER ends with a period / comma / ellipsis
      - timing_offset shifts everything
    """
    raw: list[list] = []  # [start, end, text]
    for cue in cues:
        words_text = []
        for w in cue:
            t = w["text"]
            if remove_punctuation:
                t = _clean_punctuation(t)
            if t:
                words_text.append(t)

        # Never ends with a period / comma — ever.
        text = _strip_trailing_punct(" ".join(words_text).strip())
        if not text:
            continue
        start = cue[0]["start"]
        end = cue[-1]["end"]
        if start is None:
            start = raw[-1][1] if raw else 0.0

        last = cue[-1]
        if last.get("segment_boundary") and last.get("seg_end") is not None:
            end = max(end if end is not None else 0.0, last["seg_end"])

        if end is None:
            end = start
        end += end_padding
        raw.append([start, end, text])

    entries: list[tuple[float, float, str]] = []
    n = len(raw)
    for i, (start, end, text) in enumerate(raw):
        next_start = raw[i + 1][0] if i + 1 < n else None
        if end < start + min_display_sec:
            end = start + min_display_sec
        if next_start is not None and end > next_start - 0.02:
            end = max(next_start - 0.02, start + 0.1)
        start += timing_offset
        end += timing_offset
        if start < 0:
            end = max(end - start, 0.1)
            start = 0.0
        entries.append((start, end, text))
    return entries


def _entry_to_srt_blocks(
    start: float,
    end: float,
    text: str,
    max_chars_per_line: int | None,
    max_lines_per_subtitle: int | None,
) -> list[str]:
    """
    Render one (start, end, text) entry into one or more SRT block bodies
    ("HH:MM:SS,mmm --> HH:MM:SS,mmm\\ntext...") without the index number.
    """
    lines = _wrap_text(text, None, max_chars_per_line)
    line_chunks = _chunk_lines(lines, max_lines_per_subtitle)

    # The last line of EVERY block (including blocks created by splitting a
    # long cue mid-sentence) must never end with a period / comma / ellipsis.
    # Empty lines left over after stripping are dropped; empty blocks skipped.
    cleaned_chunks: list[list[str]] = []
    for chunk in line_chunks:
        chunk = [l for l in chunk if l.strip()]
        if not chunk:
            continue
        chunk[-1] = _strip_trailing_punct(chunk[-1])
        if not chunk[-1]:
            chunk = chunk[:-1]
            if chunk:
                chunk[-1] = _strip_trailing_punct(chunk[-1])
        if chunk:
            cleaned_chunks.append(chunk)
    line_chunks = cleaned_chunks
    if not line_chunks:
        return []

    if len(line_chunks) == 1:
        block_text = "\n".join(sanitize_rtl_text(l) for l in line_chunks[0])
        return [f"{_format_timestamp(start)} --> {_format_timestamp(end)}\n{block_text}"]

    # Split the time range across chunks proportionally to character count.
    chunk_char_counts = [max(sum(len(l) for l in c), 1) for c in line_chunks]
    total_chars = sum(chunk_char_counts)
    duration = max(end - start, 0.0)

    blocks = []
    cursor = start
    for i, (chunk, char_count) in enumerate(zip(line_chunks, chunk_char_counts)):
        is_last = i == len(line_chunks) - 1
        chunk_end = end if is_last else cursor + duration * (char_count / total_chars)
        block_text = "\n".join(sanitize_rtl_text(l) for l in chunk)
        blocks.append(f"{_format_timestamp(cursor)} --> {_format_timestamp(chunk_end)}\n{block_text}")
        cursor = chunk_end
    return blocks


def _final_period_guard(block: str) -> str:
    """
    Last line of defense, applied to every finished SRT block just before it
    is written to disk. If the block's text (ignoring the invisible bidi
    isolates Premiere needs) still ends with a period/comma/ellipsis, strip
    it and keep the closing PDI isolate intact.
    """
    head, _, body = block.partition("\n")
    if not body:
        return block
    lines = body.split("\n")
    last = lines[-1]
    closing = ""
    while last and last[-1] in (_PDI,):
        closing = last[-1] + closing
        last = last[:-1]
    last = _strip_trailing_punct(last)
    lines[-1] = last + closing
    return head + "\n" + "\n".join(lines)


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
    max_lines_per_subtitle: int | None,
    cue_gap_sec: float,
    min_cue_duration: float,
    remove_punctuation: bool,
    custom_vocabulary: str | None = None,
    timing_offset: float = 0.0,
    end_padding: float = 0.15,
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

    # initial_prompt ממילון המונחים: רמז הקשר למודל, לא מכריח איות.
    initial_prompt = None
    if custom_vocabulary:
        terms = [t.strip() for t in custom_vocabulary.split(",") if t.strip()]
        if terms:
            initial_prompt = "מילון מונחים רלוונטי: " + ", ".join(terms) + "."
            _log(f"Custom vocabulary ({len(terms)} terms): {', '.join(terms)}")

    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=1000),
        word_timestamps=True,
        initial_prompt=initial_prompt,
        condition_on_previous_text=True,
    )
    _log(
        f"Detected language: {info.language} "
        f"(prob={info.language_probability:.2f})"
    )

    # ── Consume segments, emit progress, collect words ────────────────────────
    word_stream: list[dict] = []
    segment_index = 0
    t_start = time.monotonic()

    for segment in segments_iter:
        segment_index += 1
        elapsed = time.monotonic() - t_start

        if audio_duration and audio_duration > 0:
            progress_pct = min(segment.end / audio_duration * 100, 100.0)
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

        word_stream.extend(_flatten_words(segment))

    # ── Regroup words into short cues, then render SRT blocks ─────────────────
    word_stream = _tighten_word_timings(word_stream)
    cues = _group_words_into_cues(word_stream, max_words_per_line, cue_gap_sec)
    timed_entries = _cues_to_timed_entries(
        cues, min_cue_duration, remove_punctuation, timing_offset, end_padding
    )

    srt_blocks: list[str] = []
    for start, end, text in timed_entries:
        srt_blocks.extend(
            _entry_to_srt_blocks(start, end, text, max_chars_per_line, max_lines_per_subtitle)
        )

    # Final safety net: no block may end with a period, ever.
    srt_blocks = [_final_period_guard(b) for b in srt_blocks]

    # ── Write SRT ─────────────────────────────────────────────────────────────
    numbered_blocks = [f"{i}\n{block}" for i, block in enumerate(srt_blocks, start=1)]
    out_path = Path(srt_out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    srt_content = "\n\n".join(numbered_blocks) + "\n"
    out_path.write_text(srt_content, encoding="utf-8")

    elapsed_total = round(time.monotonic() - t_start, 1)
    subtitle_count = len(numbered_blocks)
    _emit({
        "event":          "done",
        "subtitle_count": subtitle_count,
        "elapsed_sec":    elapsed_total,
        "srt_path":       str(out_path.resolve()),
    })
    _log(f"Done — {subtitle_count} subtitles in {elapsed_total}s → {out_path}")


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
                  --max-chars-per-line 42 --max-lines-per-subtitle 2 \\
                  --gap 0.6 --min-duration 0.4 --remove-punctuation
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
                        help="Max words per subtitle cue. Cues also break early on "
                             "sentence-ending punctuation, pauses longer than --gap, "
                             "or the end of a whisper segment.")
    parser.add_argument("--max-chars-per-line", type=int, default=None, metavar="N",
                        help="Max characters per SRT display line.")
    parser.add_argument("--max-lines-per-subtitle", type=int, default=None, metavar="N",
                        help="Max display lines per subtitle block. Longer cues are "
                             "split into consecutive blocks with proportional timing.")
    parser.add_argument("--gap",         type=float, default=0.6, metavar="SEC",
                        help="Pause (seconds) between words that forces a new cue (default: 0.6).")
    parser.add_argument("--min-duration", type=float, default=0.4, metavar="SEC",
                        help="Minimum on-screen duration of a cue in seconds (default: 0.4).")
    parser.add_argument("--timing-offset", type=float, default=0.0, metavar="SEC",
                        help="Shift all subtitles by this many seconds. Negative = "
                             "earlier, positive = later (default: 0.0).")
    parser.add_argument("--end-padding", type=float, default=0.15, metavar="SEC",
                        help="Extra time added to the end of every subtitle "
                             "(default: 0.15). Never overlaps the next subtitle.")
    parser.add_argument("--remove-punctuation", action="store_true",
                        help="Remove all punctuation from subtitles. (Trailing periods "
                             "and commas are ALWAYS removed, with or without this flag.)")
    parser.add_argument("--custom-vocabulary", default=None, metavar="TERMS",
                        help="Comma-separated names/terms to bias the model towards "
                             "(e.g. 'John Smith, ivrit-ai, AutoCaps').")
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
        max_lines_per_subtitle=args.max_lines_per_subtitle,
        cue_gap_sec=args.gap,
        min_cue_duration=args.min_duration,
        remove_punctuation=args.remove_punctuation,
        custom_vocabulary=args.custom_vocabulary,
        timing_offset=args.timing_offset,
        end_padding=args.end_padding,
    )


if __name__ == "__main__":
    main()