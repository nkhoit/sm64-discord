#!/usr/bin/env python3
"""Summarize bounded, owner-only SM64 relay diagnostic JSONL files.

Remote samples are untrusted indicators, not proof of a particular audio fault.
This tool intentionally never prints report bodies, room names, or request credentials.
"""

import argparse
import collections
import datetime as dt
import json
import math
import os
import re
import stat
import sys
from pathlib import Path

MAX_FILES = 16
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 64 * 1024
SESSION_RE = re.compile(r"^[0-9a-f]{32}$")
FILE_RE = re.compile(r"^diagnostics-(\d{1,20})-([0-9a-f]{16})\.jsonl$")
CATEGORIES = {"audio", "performance", "network", "runtime", "other"}
KINDS = {"periodic", "issue", "error"}
AUDIO_STATES = {"unavailable", "suspended", "running", "closed", "interrupted"}
CUMULATIVE_COUNTERS = ("callbacks", "lateCallbacks", "sampledFrames", "clippedSamples", "boundaryJumps")
SAMPLE_COUNTERS = ("emptyDelta", "droppedDelta")
COUNTERS = SAMPLE_COUNTERS + CUMULATIVE_COUNTERS
MAXIMUMS = ("sampleRate", "queueFrames", "peak", "maxCallbackGapMs")
MAX_SEQUENCE = 9_007_199_254_740_991


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", default="relay-data/diagnostics",
                        help="diagnostics directory (default: relay-data/diagnostics)")
    parser.add_argument("--last", type=int, default=100, help="summarize at most this many recent records (1..1000)")
    parser.add_argument("--hours", type=float, default=24, help="include records from this many recent hours (0..168]")
    args = parser.parse_args()
    if not 1 <= args.last <= 1000:
        parser.error("--last must be between 1 and 1000")
    if not math.isfinite(args.hours) or not 0 < args.hours <= 168:
        parser.error("--hours must be greater than 0 and at most 168")
    return args


def safe_files(directory):
    try:
        root_stat = os.lstat(directory)
    except OSError as exc:
        raise RuntimeError("diagnostics directory is unavailable") from exc
    if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
        raise RuntimeError("diagnostics path is not a directory")
    entries = []
    try:
        with os.scandir(directory) as scan:
            for entry in scan:
                if len(entries) >= MAX_FILES:
                    raise RuntimeError("diagnostics directory exceeds the bounded file count")
                match = FILE_RE.fullmatch(entry.name)
                if not match:
                    raise RuntimeError("diagnostics directory contains an unexpected entry")
                try:
                    item_stat = entry.stat(follow_symlinks=False)
                except OSError:
                    raise RuntimeError("diagnostic file metadata is unavailable") from None
                if (not stat.S_ISREG(item_stat.st_mode) or item_stat.st_nlink != 1
                        or item_stat.st_size < 0 or item_stat.st_size > MAX_FILE_BYTES):
                    raise RuntimeError("diagnostic file is not a bounded regular file")
                entries.append((int(match.group(1)), entry.name, item_stat.st_size))
    except OSError as exc:
        raise RuntimeError("diagnostics directory could not be scanned") from exc
    if sum(item[2] for item in entries) > MAX_TOTAL_BYTES:
        raise RuntimeError("diagnostics files exceed the bounded total size")
    return sorted(entries)


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        return None
    return parsed.astimezone(dt.timezone.utc)


def bounded_metric(value, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or value > 100_000_000:
        return None
    if integer and int(value) != value:
        return None
    return value


def load_recent(directory, last, hours, now):
    files = safe_files(directory)
    cutoff = now - dt.timedelta(hours=hours)
    recent = collections.deque(maxlen=last)
    malformed = 0
    too_old = 0
    read_bytes = 0
    for _, name, expected_size in files:
        path = os.path.join(directory, name)
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        except OSError:
            malformed += 1
            continue
        try:
            opened = os.fstat(fd)
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or opened.st_size != expected_size or opened.st_size > MAX_FILE_BYTES):
                malformed += 1
                continue
            read_bytes += opened.st_size
            if read_bytes > MAX_TOTAL_BYTES:
                raise RuntimeError("diagnostic reads exceeded the bounded total size")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                remaining = expected_size
                while remaining > 0:
                    line = stream.readline(min(MAX_LINE_BYTES + 1, remaining))
                    if not line:
                        break
                    remaining -= len(line)
                    if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                        malformed += 1
                        while line and not line.endswith(b"\n") and remaining > 0:
                            line = stream.readline(min(MAX_LINE_BYTES + 1, remaining))
                            remaining -= len(line)
                        continue
                    try:
                        row = json.loads(line)
                    except (UnicodeDecodeError, ValueError, RecursionError):
                        malformed += 1
                        continue
                    received = timestamp(row.get("receivedAt")) if isinstance(row, dict) else None
                    report = row.get("report") if isinstance(row, dict) else None
                    session = row.get("sessionId") if isinstance(row, dict) else None
                    category = report.get("category") if isinstance(report, dict) else None
                    kind = report.get("kind") if isinstance(report, dict) else None
                    sequence = report.get("seq") if isinstance(report, dict) else None
                    if (received is None or received > now or not isinstance(report, dict)
                            or not isinstance(session, str) or not SESSION_RE.fullmatch(session)
                            or not isinstance(category, str) or category not in CATEGORIES
                            or not isinstance(kind, str) or kind not in KINDS
                            or isinstance(sequence, bool) or not isinstance(sequence, int)
                            or not 1 <= sequence <= MAX_SEQUENCE
                            or not isinstance(report.get("sample"), dict)):
                        malformed += 1
                        continue
                    if received < cutoff:
                        too_old += 1
                        continue
                    recent.append({"received": received, "session": session, "seq": sequence,
                                   "category": report["category"], "kind": report["kind"],
                                   "sample": report["sample"]})
        finally:
            os.close(fd)
    return list(recent), malformed, too_old, len(files), read_bytes


def deduplicate_records(records):
    """Keep one record per session/sequence; newest receipt wins duplicate retries."""
    unique = {}
    duplicates = 0
    for index, row in enumerate(records):
        key = (row["session"], row["seq"])
        previous = unique.get(key)
        if previous is None:
            unique[key] = (index, row)
        else:
            duplicates += 1
            # Retries normally repeat an identical body. If they do not, use the
            # latest received valid row; equal timestamps retain the first row.
            if row["received"] > previous[1]["received"]:
                unique[key] = (index, row)
    return [row for _, row in sorted(unique.values(), key=lambda item: item[0])], duplicates


def summarize(records):
    categories = collections.Counter(row["category"] for row in records)
    kinds = collections.Counter(row["kind"] for row in records)
    sessions = collections.Counter(row["session"] for row in records)
    audio_states = collections.Counter()
    audio_samples = 0
    totals = collections.Counter()
    latest_cumulative = {}
    maxima = collections.defaultdict(float)
    for row in records:
        audio = row["sample"].get("audio")
        if not isinstance(audio, dict):
            continue
        state = audio.get("state")
        if isinstance(state, str) and state in AUDIO_STATES:
            audio_states[state] += 1
        audio_samples += 1
        for key in SAMPLE_COUNTERS:
            number = bounded_metric(audio.get(key), integer=True)
            if number is not None:
                totals[key] += int(number)
        session_latest = latest_cumulative.setdefault(row["session"], {})
        for key in CUMULATIVE_COUNTERS:
            number = bounded_metric(audio.get(key), integer=True)
            current = session_latest.get(key)
            if number is not None and (current is None or row["seq"] > current[0]):
                session_latest[key] = (row["seq"], int(number))
        for key in MAXIMUMS:
            number = bounded_metric(audio.get(key))
            if number is not None:
                maxima[key] = max(maxima[key], number)
    for values in latest_cumulative.values():
        for key, (_, number) in values.items():
            totals[key] += number
    return categories, kinds, sessions, audio_states, audio_samples, totals, maxima


def main():
    args = parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    try:
        records, malformed, too_old, file_count, read_bytes = load_recent(args.directory, args.last, args.hours, now)
    except RuntimeError as exc:
        print(f"diagnostics-summary: {exc}", file=sys.stderr)
        return 2

    records, duplicate_reports = deduplicate_records(records)
    categories, kinds, sessions, audio_states, audio_samples, totals, maxima = summarize(records)
    print(f"Diagnostics summary: {len(records)} unique recent report(s), window={args.hours:g}h, last={args.last}")
    print(f"Files read: {file_count}; bytes streamed: {read_bytes}; outside window skipped: {too_old}")
    print(f"duplicate report retries skipped: {duplicate_reports}")
    print("Categories (unique reports): " + (", ".join(f"{key}={categories[key]}" for key in sorted(CATEGORIES) if categories[key]) or "none"))
    print("Kinds (unique reports): " + (", ".join(f"{key}={kinds[key]}" for key in sorted(KINDS) if kinds[key]) or "none"))
    print(f"Sessions: {len(sessions)} unique pseudonymous session(s)")
    for session, count in sessions.most_common(10):
        print(f"  {session}: {count} unique report(s)")
    print(f"Audio indicators: {audio_samples} unique report sample(s)")
    print("  states: " + (", ".join(f"{key}={audio_states[key]}" for key in sorted(AUDIO_STATES) if audio_states[key]) or "none"))
    for key in COUNTERS:
        if key in CUMULATIVE_COUNTERS:
            print(f"  {key} latest observed cumulative (sum across sessions): {totals[key]}")
        else:
            print(f"  {key} observed sample sum: {totals[key]}")
    for key in MAXIMUMS:
        print(f"  {key} maximum: {maxima[key]:g}")
    print(f"malformed lines skipped: {malformed}")
    print("Interpretation: cumulative counters may predate the query window; each value is the latest observed per-session snapshot and is not a window event total.")
    print("Observed delta sums include one current sample per unique report; they are not complete session totals. History arrays are not aggregated.")
    print("Remote audio indicators are untrusted telemetry, not proof of a specific crackle or audio defect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
