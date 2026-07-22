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
import re
import sys
import textwrap
import time
from datetime import timedelta
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# CUDA PATH CONFIGURATION
# Pulls the CUDA directory dynamically from the environment variable 
# sent by the Premiere Pro extension.
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
    sys.stdout.buffer.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


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


def _chunk_lines(lines: list[str], max_lines: int | None) -> list[list[str]]:
    """
    Group display lines into chunks of at most max_lines lines each.
    Each chunk becomes its own SRT block. If max_lines is None, all
    lines stay together in a single chunk (original behavior).
    """
    if not max_lines or max_lines <= 0:
        return [lines]
    return [lines[i : i + max_lines] for i in range(0, len(lines), max_lines)] or [lines]


# ──────────────────────────────────────────────────────────────────────────────
# Word-level cue grouping
#
# Instead of dumping each whisper *segment* straight into one subtitle block,
# we flatten every segment down to its individual timestamped words and then
# regroup those words into short "cues". A cue ends whenever we hit a word
# cap, a noticeable pause, sentence-ending punctuation, or the boundary of
# the original whisper segment — whichever comes first. This produces
# tighter, more natural-feeling subtitles than one block per raw segment.
# ──────────────────────────────────────────────────────────────────────────────

_SENTENCE_END_CHARS = set(".?!:;׃…")  # includes Hebrew sof-pasuq (׃) and ellipsis


# ──────────────────────────────────────────────────────────────────────────────
# Hebrew / bidi text sanitizer
#
# Premiere Pro's caption renderer doesn't run a full Unicode bidi algorithm on
# RTL text, so a few things reliably break:
#   1. Sentence-ending punctuation (. ? ! : ; …) at the end of a Hebrew line
#      sometimes gets thrown to the wrong (left) side of the screen.
#   2. An embedded English word/number in a Hebrew sentence (e.g. a product
#      name) can invert the reading order of the surrounding Hebrew words.
#   3. Straight ASCII quotes used for Hebrew acronyms (e.g. צה"ל, ד"ר) are
#      ambiguous punctuation glyphs and can confuse line-wrapping / bidi
#      resolution; they should be the proper Hebrew gershayim (״) / geresh (׳)
#      characters instead.
#
# This sanitizer fixes all three by injecting invisible Unicode directional
# isolate characters and normalizing acronym punctuation. It is applied once,
# on the final wrapped display lines, right before they are written into the
# .srt file — after word/char wrapping so it can't skew any wrap-width
# decisions.
#
# Important: Premiere's caption renderer does not auto-detect RTL as the base
# direction of a Hebrew line — it defaults to LTR unless told otherwise
# explicitly, and it does NOT honor bare neutral hints like a lone RLM
# (Right-to-Left Mark). It DOES honor explicit directional isolates (LRI/RLI
# ... PDI), so every fix here — embedded Latin runs and the line as a whole —
# uses explicit isolates rather than neutral marks.
# ──────────────────────────────────────────────────────────────────────────────

_LRI = "\u2066"  # Left-to-Right Isolate
_RLI = "\u2067"  # Right-to-Left Isolate
_PDI = "\u2069"  # Pop Directional Isolate

_HEBREW_RANGE = "\u0590-\u05FF\uFB1D-\uFB4F"
_HEBREW_CHAR_RE = re.compile(f"[{_HEBREW_RANGE}]")

# A contiguous run of Latin letters/digits (plus common "glued" symbols like
# . _ - / @ : + #) that starts and ends on an alnum char, e.g. "GitHub",
# "v3-turbo", "GPT-4". Runs are matched individually (no spaces) so that
# "New York" is isolated as two words, each staying internally LTR without
# swallowing the Hebrew around it.
_LATIN_RUN_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._\-/@:+#]*[A-Za-z0-9])?")

# ASCII quote/apostrophe sitting between two Hebrew letters == acronym marker
# (e.g. צה"ל, ד"ר, רח' = an abbreviation, not a quotation).
_GERSHAYIM_RE = re.compile(f'([{_HEBREW_RANGE}])"([{_HEBREW_RANGE}])')
# Geresh after a Hebrew letter, either mid-word (רח'ל) or at a word boundary
# like the end of an abbreviation (רח' = "street"), but not a real quote
# (i.e. not followed by more free-standing text before the next quote).
_GERESH_RE = re.compile(f"([{_HEBREW_RANGE}])'(?=[{_HEBREW_RANGE}]|\\B|$)")


def _fix_hebrew_acronym_quotes(text: str) -> str:
    """
    Replace straight ASCII quotes/apostrophes used inside Hebrew acronyms
    (צה"ל, ד"ר, רח') with the correct Hebrew gershayim (״) / geresh (׳)
    punctuation, so they read as part of the word instead of as a quote
    delimiter and don't break line-wrapping.
    """
    prev = None
    while prev != text:
        prev = text
        text = _GERSHAYIM_RE.sub("\\1\u05F4\\2", text)
        text = _GERESH_RE.sub("\\1\u05F3", text)
    return text


def _isolate_embedded_latin(text: str) -> str:
    """
    Wrap runs of embedded Latin letters/digits (English words, product
    names, version numbers, acronyms like GitHub) in Unicode directional
    isolates (LRI ... PDI) so Premiere keeps them as a contained
    left-to-right island and does not reorder the surrounding Hebrew words.
    """
    if not _HEBREW_CHAR_RE.search(text):
        return text  # pure English/numeric line — nothing to isolate against
    return _LATIN_RUN_RE.sub(lambda m: f"{_LRI}{m.group(0)}{_PDI}", text)


def _force_rtl_paragraph(text: str) -> str:
    """
    Wrap the entire display line in an explicit RTL isolate (RLI ... PDI).

    Premiere's caption renderer does not auto-detect RTL as the base
    direction of a Hebrew paragraph/line — it appears to default to LTR
    unless told otherwise explicitly. That means any neutral character at
    the very end of the line (typically trailing punctuation) with nothing
    after it to inherit direction from falls back to the LTR default and
    renders on the wrong (right) side, even when it's individually isolated.
    Forcing the whole line into an RTL isolate fixes this at the source,
    since Premiere does honor explicit directional isolates (proven by the
    Latin-run isolation in _isolate_embedded_latin already working).
    """
    if not _HEBREW_CHAR_RE.search(text):
        return text
    return f"{_RLI}{text}{_PDI}"


def sanitize_rtl_text(text: str) -> str:
    """
    Run the full Hebrew/bidi cleanup pipeline on one display line before it
    is written into the SRT file.
    """
    if not text:
        return text
    text = _fix_hebrew_acronym_quotes(text)
    text = _isolate_embedded_latin(text)
    text = _force_rtl_paragraph(text)
    return text


def _flatten_words(segment) -> list[dict]:
    """
    Pull per-word timestamps out of a faster-whisper segment. Falls back to
    treating the whole segment as a single "word" if word timestamps weren't
    produced (e.g. word_timestamps was off for this run).
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
            })
    else:
        text = segment.text.strip()
        if text:
            words_out.append({
                "text": text,
                "start": segment.start,
                "end": segment.end,
                "segment_boundary": True,
            })
    return words_out


def _group_words_into_cues(
    words: list[dict],
    max_words_per_cue: int | None,
    silence_gap_sec: float,
) -> list[list[dict]]:
    """
    Greedily walk the flattened word stream and split it into cues. A new
    cue boundary is drawn as soon as one of these is true for the current
    word:
      - the cue already reached max_words_per_cue (if a cap was given)
      - the current word ends a sentence
      - the current word is the last word of its whisper segment
      - the pause before the *next* word exceeds silence_gap_sec
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
    פונקציית עזר להסרת סימני פיסוק מהמילים.
    משאירה גרשיים וגרש פנימיים המרכיבים קיצורים בעברית (כמו צה"ל או ד"ר)
    אך מסירה מירכאות חיצוניות המקיפות את המילה.
    """
    # רשימת סימני פיסוק כלליים ועבריים להסרה
    to_remove = '.?!:;׃…,,()[]{}' + '/;<>=-+*&^%$#@~`|\\_–—'
    table = str.maketrans("", "", to_remove)
    text = text.translate(table)
    # הסרת מירכאות/גרשים מקצוות המילה בלבד (למשל: "שלום" -> שלום, 'היי' -> היי)
    text = text.strip('\'"')
    return text


def _cues_to_timed_entries(
    cues: list[list[dict]], 
    min_display_sec: float, 
    remove_punctuation: bool = False
) -> list[tuple[float, float, str]]:
    """
    Turn word cues into (start, end, text) triples, enforcing a minimum
    on-screen duration and preventing any overlap with the previous entry.
    """
    entries: list[tuple[float, float, str]] = []
    last_end = 0.0
    for cue in cues:
        words_text = []
        for w in cue:
            t = w["text"]
            if remove_punctuation:
                t = _clean_punctuation(t)
            words_text.append(t)

        text = " ".join(words_text).strip()
        if not text:
            continue
        start = cue[0]["start"] if cue[0]["start"] is not None else last_end
        end = cue[-1]["end"] if cue[-1]["end"] is not None else start
        start = max(start, last_end)
        if end < start + min_display_sec:
            end = start + min_display_sec
        entries.append((start, end, text))
        last_end = end
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
    ("HH:MM:SS,mmm --> HH:MM:SS,mmm\\ntext..."), without the leading index
    number (that's assigned once, globally, at write time).
    """
    lines = _wrap_text(text, None, max_chars_per_line)
    line_chunks = _chunk_lines(lines, max_lines_per_subtitle)

    if len(line_chunks) == 1:
        block_text = "\n".join(sanitize_rtl_text(l) for l in line_chunks[0])
        return [f"{_format_timestamp(start)} --> {_format_timestamp(end)}\n{block_text}"]

    # Split the entry's time range across chunks, proportional to each
    # chunk's character count, so multi-block cues still roughly track
    # the speech timing.
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
    remove_punctuation: bool, # פרמטר חדש שהתווסף
    custom_vocabulary: str | None = None, # מילון מונחים מותאם אישית (שמות, מונחים מקצועיים וכו')
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

    # בניית initial_prompt ממילון המונחים המותאם אישית (אם סופק).
    # Whisper משתמש ב-prompt הזה כ"רמז הקשר" כדי להטות את הזיהוי לכיוון
    # המונחים/שמות שהמשתמש ציין, מבלי לשנות בפועל את הטקסט המתומלל.
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
        vad_parameters=dict(min_silence_duration_ms=500),
        word_timestamps=True,
        initial_prompt=initial_prompt,
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

        word_stream.extend(_flatten_words(segment))

    # ── Regroup words into short cues, then render SRT blocks ─────────────────
    # חלוקת המשפטים מתרחשת לפי המבנה המקורי (נקודות, פסיקים וכו') כדי לשמור על מקצב טבעי,
    # אך רק בשלב ההרכבה הטקסט עצמו מנוקה במידה והדגל פעיל.
    cues = _group_words_into_cues(word_stream, max_words_per_line, cue_gap_sec)
    timed_entries = _cues_to_timed_entries(cues, min_cue_duration, remove_punctuation)

    srt_blocks: list[str] = []
    for start, end, text in timed_entries:
        srt_blocks.extend(_entry_to_srt_blocks(start, end, text, max_chars_per_line, max_lines_per_subtitle))

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
                        help="Max display lines per subtitle block. If a cue's wrapped "
                             "text exceeds this, it is split into multiple consecutive "
                             "subtitle blocks with proportionally split timing.")
    parser.add_argument("--gap",         type=float, default=0.6, metavar="SEC",
                        help="Pause (in seconds) between words that forces a new "
                             "subtitle cue to start (default: 0.6).")
    parser.add_argument("--min-duration", type=float, default=0.4, metavar="SEC",
                        help="Minimum on-screen duration for any single subtitle "
                             "cue, in seconds (default: 0.4).")
    # הוספת הפרמטר ל-CLI
    parser.add_argument("--remove-punctuation", action="store_true",
                        help="Remove punctuation from subtitles (e.g. periods, commas, question marks).")
    parser.add_argument("--custom-vocabulary", default=None, metavar="TERMS",
                        help="Comma-separated list of names/terms to bias the model towards "
                             "(e.g. 'John Smith, ivrit-ai, AutoCaps'). Passed to the model as "
                             "context, does not force exact spelling.")
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
        remove_punctuation=args.remove_punctuation, # העברת הפרמטר
        custom_vocabulary=args.custom_vocabulary,
    )


if __name__ == "__main__":
    main()