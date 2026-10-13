#!/usr/bin/env python3
"""Converts the shipped sound data (laid out for 64-bit pointers) for 32-bit targets such as wasm32.

    sound_data_32bit.py ctl|seqfile <64-bit input> <32-bit output>

seqfile (sound_data.tbl, sequences.bin): only the file header holds pointers, so it is rewritten in
place and the sample/sequence data stays at the same offsets. That matters: the game copies the real
samples and sequences out of the ROM to the offsets in sound/samples_offsets.h and
sound/sequences_offsets.h, which were computed for the 64-bit files.

ctl (sound_data.ctl): the sound banks are full of pointers (instrument and drum tables, instruments,
drums, sample headers). Each bank is re-laid out the way tools/assemble_sound.py --bitwidth 32 would,
keeping every sample's offset into the 64-bit sample table.
"""
import struct
import sys

ALIGN = 16


def align(value, alignment=ALIGN):
    return (value + alignment - 1) & -alignment


def read_header64(data):
    magic, count, pad = struct.unpack_from("<HHI", data, 0)
    assert pad == 0, "not a 64-bit sound data file"
    entries = [struct.unpack_from("<QII", data, 8 + 16 * i) for i in range(count)]
    assert all(e[2] == 0 for e in entries), "not a 64-bit sound data file"
    return magic, [(offset, length) for offset, length, _ in entries]


def header32(magic, entries):
    header = struct.pack("<HH", magic, len(entries))
    for offset, length in entries:
        header += struct.pack("<II", offset, length)
    return header + b"\0" * (align(len(header)) - len(header))


def convert_seqfile(data):
    magic, entries = read_header64(data)
    header = header32(magic, entries)
    data_start = min(offset for offset, _ in entries)
    assert len(header) <= data_start
    return header + b"\0" * (data_start - len(header)) + data[data_start:]


def convert_bank(bank):
    """bank: one sound bank from the 64-bit ctl (16-byte header, then pointer-relative data)."""
    num_instruments, num_drums = struct.unpack_from("<II", bank, 0)
    src = bank[16:]
    q = lambda pos: struct.unpack_from("<Q", src, pos)[0]

    # Find every object, keyed by its 64-bit offset: (kind, 64-bit size)
    objects = {0: ("tables", 8 + 8 * num_instruments)}
    def add_sound(pos):
        sample = q(pos)
        if sample:
            objects[sample] = ("sample", 36)
            objects[q(sample + 16)] = ("raw", None)  # loop
            objects[q(sample + 24)] = ("raw", None)  # book
    for i in range(num_instruments):
        inst = q(8 + 8 * i)
        if inst:
            objects[inst] = ("instrument", 64)
            objects[q(inst + 8)] = ("raw", None)  # envelope
            for s in range(3):
                add_sound(inst + 16 + 16 * s)
    drum_table = q(0)
    if num_drums:
        objects[drum_table] = ("drum_table", 8 * num_drums)
        for i in range(num_drums):
            drum = q(drum_table + 8 * i)
            objects[drum] = ("drum", 32)
            add_sound(drum + 8)
            objects[q(drum + 24)] = ("raw", None)  # envelope

    # Lay them out again in the same order. Pointer-free objects (books, loops, envelopes) are copied
    # with everything up to the next known object, so nothing unreferenced is lost.
    starts = sorted(objects)
    new_pos = {}
    pos = 0
    for i, start in enumerate(starts):
        kind, size = objects[start]
        end = starts[i + 1] if i + 1 < len(starts) else len(src)
        new_pos[start] = pos
        if kind == "raw":
            pos += end - start
        else:
            assert end - start == align(size), f"unexpected data after a {kind} at {start:#x}"
            size32 = {"tables": 4 + 4 * num_instruments, "sample": 20, "instrument": 32,
                      "drum": 16, "drum_table": 4 * num_drums}[kind]
            pos = align(pos + size32)  # drums are packed back to back, but at 16 bytes that is the same

    out = bytearray(pos)
    ptr = lambda old: new_pos[old] if old else 0
    def put_sound(at, old):
        struct.pack_into("<If", out, at, ptr(q(old)), struct.unpack_from("<f", src, old + 8)[0])
    for start, (kind, _) in objects.items():
        at = new_pos[start]
        if kind == "raw":
            end = next((s for s in starts if s > start), len(src))
            out[at:at + end - start] = src[start:end]
        elif kind == "tables":
            struct.pack_into("<I", out, at, ptr(drum_table) if num_drums else 0)
            for i in range(num_instruments):
                struct.pack_into("<I", out, at + 4 + 4 * i, ptr(q(8 + 8 * i)))
        elif kind == "sample":
            unused, = struct.unpack_from("<I", src, start)
            offset_in_tbl, loop, book = q(start + 8), q(start + 16), q(start + 24)
            size, = struct.unpack_from("<I", src, start + 32)
            struct.pack_into("<IIIII", out, at, unused, offset_in_tbl, ptr(loop), ptr(book), size)
        elif kind == "instrument":
            out[at:at + 4] = src[start:start + 4]
            struct.pack_into("<I", out, at + 4, ptr(q(start + 8)))
            for s in range(3):
                put_sound(at + 8 + 8 * s, start + 16 + 16 * s)
        elif kind == "drum":
            out[at:at + 4] = src[start:start + 4]
            put_sound(at + 4, start + 8)
            struct.pack_into("<I", out, at + 12, ptr(q(start + 24)))
        elif kind == "drum_table":
            for i in range(num_drums):
                struct.pack_into("<I", out, at + 4 * i, ptr(q(start + 8 * i)))
    return bank[:16] + bytes(out)


def convert_ctl(data):
    magic, entries = read_header64(data)
    banks = [convert_bank(data[offset:offset + length]) for offset, length in entries]
    data_start = len(header32(magic, entries))
    new_entries, body = [], b""
    for bank in banks:
        new_entries.append((data_start + len(body), len(bank)))
        body += bank
    body += b"\0"
    out = header32(magic, new_entries) + body
    return out + b"\0" * (align(len(out), 64) - len(out))


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("ctl", "seqfile"):
        sys.exit(__doc__)
    with open(sys.argv[2], "rb") as f:
        data = f.read()
    data = convert_ctl(data) if sys.argv[1] == "ctl" else convert_seqfile(data)
    with open(sys.argv[3], "wb") as f:
        f.write(data)
