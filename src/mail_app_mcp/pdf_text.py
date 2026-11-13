"""Run the PDF parser with CPU limits and a macOS RSS watchdog."""

import json
import os
from pathlib import Path
import resource
import sys
import threading
import time

MAX_PAGES = 50
MAX_TEXT = 100_000
MAX_MEMORY = 512 * 1024 * 1024


def watch_memory() -> None:
    # shortcut: sampled Darwin RSS can overshoot; use OS isolation for a hard memory boundary.
    while resource.getrusage(resource.RUSAGE_SELF).ru_maxrss <= MAX_MEMORY:
        time.sleep(0.02)
    os._exit(1)


def extract_pdf(path: Path) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(path)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are unsupported")
    pieces = ()
    length = 0
    for page in reader.pages[:MAX_PAGES]:
        text = page.extract_text() or ""
        pieces = (*pieces, text[:MAX_TEXT - length])
        length += len(text)
        if length >= MAX_TEXT:
            break
    text = "\n".join(pieces)[:MAX_TEXT]
    unmapped = text.count("\x00")
    return {"text": text.replace("\x00", "\ufffd"),
            "truncated": len(reader.pages) > MAX_PAGES or length >= MAX_TEXT,
            "pages": len(reader.pages),
            **({"warning": f"{unmapped} characters could not be mapped; replaced with U+FFFD"} if unmapped else {})}


def main() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    threading.Thread(target=watch_memory, daemon=True).start()
    try:
        result = extract_pdf(Path(sys.argv[1]))
    except Exception:
        result = {"error": "PDF extraction failed"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
