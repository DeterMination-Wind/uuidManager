#!/usr/bin/env python3
"""
Fast UUID8/UID search helper for Mindustry shortID workflow.

Supports:
1) Direct UID16(Base64) -> UUID8(Base64) inversion (no brute force)
2) Multi-process brute force for 3-char shortID (Wayzer shortID.kts algorithm)

Algorithm for shortID:
  uid16 = base64( uuid8_bytes + 4 zero bytes + crc32(uuid8_bytes) big-endian )
  short = base64( md5(md5(uid16_utf8) + uid16_utf8) )[0:3]
  map: k->K, S->s, l->L, +->A, /->B
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import multiprocessing as mp
import os
import queue
import struct
import time
import zlib
from typing import Any


MASK64 = 0xFFFFFFFFFFFFFFFF
SHORT_MAP = str.maketrans({"k": "K", "S": "s", "l": "L", "+": "A", "/": "B"})


def splitmix64(x: int) -> int:
    """Fast bijective 64-bit mixer used to generate candidate UUID8 bytes."""
    z = (x + 0x9E3779B97F4A7C15) & MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    z = z ^ (z >> 31)
    return z & MASK64


def seed_to_u64(seed: str) -> int:
    d = hashlib.blake2b(seed.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(d, "big", signed=False)


def uuid8_bytes_to_uid16_b64(uuid8: bytes) -> str:
    crc = zlib.crc32(uuid8) & 0xFFFFFFFF
    uid16 = uuid8 + b"\x00\x00\x00\x00" + struct.pack(">I", crc)
    return base64.b64encode(uid16).decode("ascii")


def shortid_from_uid16_b64(uid16_b64: str) -> str:
    bs = uid16_b64.encode("utf-8")
    d1 = hashlib.md5(bs).digest()
    d2 = hashlib.md5(d1 + bs).digest()
    return base64.b64encode(d2).decode("ascii")[:3].translate(SHORT_MAP)


def shortid_from_uuid8_bytes(uuid8: bytes) -> tuple[str, str]:
    uid16_b64 = uuid8_bytes_to_uid16_b64(uuid8)
    sid = shortid_from_uid16_b64(uid16_b64)
    return sid, uid16_b64


def uid16_to_uuid8(uid16_b64: str) -> str:
    try:
        raw = base64.b64decode(uid16_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("输入不是合法Base64 UID") from exc
    if len(raw) != 16:
        raise ValueError("输入不是16字节UID(Base64)")
    uuid8 = base64.b64encode(raw[:8]).decode("ascii")
    # integrity check
    if uuid8_bytes_to_uid16_b64(base64.b64decode(uuid8)) != uid16_b64:
        raise ValueError("UID校验失败：不是标准 uuid+crc 格式")
    return uuid8


def add_progress(progress: Any, wid: int, value: int) -> None:
    if value <= 0:
        return
    with progress.get_lock():
        progress[wid] += value


def total_progress(progress: Any) -> int:
    with progress.get_lock():
        return int(sum(progress))


def worker(
    wid: int,
    workers: int,
    target: str,
    seed64: int,
    max_iter: int,
    report_every: int,
    stop_event: Any,
    result_q: Any,
    progress: Any,
) -> None:
    i = wid
    local = 0

    while i < max_iter and not stop_event.is_set():
        # Deterministic pseudo-random 8-byte candidate.
        v = splitmix64(i ^ seed64)
        uuid8 = struct.pack(">Q", v)

        sid, uid16_b64 = shortid_from_uuid8_bytes(uuid8)
        local += 1
        if sid == target:
            uuid8_b64 = base64.b64encode(uuid8).decode("ascii")
            try:
                result_q.put_nowait((i, uuid8_b64, uid16_b64, sid))
            except Exception:
                pass
            stop_event.set()
            break

        i += workers

        if local >= report_every:
            add_progress(progress, wid, local)
            local = 0

    if local:
        add_progress(progress, wid, local)


def run_bruteforce(target: str, seed: str, max_iter: int, workers: int, report_every: int) -> int:
    seed64 = seed_to_u64(seed)
    stop_event = mp.Event()
    result_q: mp.Queue = mp.Queue()
    progress = mp.Array("Q", workers)

    procs = []
    for wid in range(workers):
        p = mp.Process(
            target=worker,
            args=(
                wid,
                workers,
                target,
                seed64,
                max_iter,
                report_every,
                stop_event,
                result_q,
                progress,
            ),
            daemon=True,
        )
        p.start()
        procs.append(p)

    start = time.time()
    last_t = start
    last_checked = 0
    found = None

    try:
        while True:
            try:
                found = result_q.get_nowait()
                break
            except queue.Empty:
                pass

            alive = any(p.is_alive() for p in procs)
            checked = total_progress(progress)
            now = time.time()

            if now - last_t >= 1.0:
                delta = checked - last_checked
                speed = delta / (now - last_t)
                print(f"checked={checked:,} speed={speed:,.0f}/s", flush=True)
                last_t = now
                last_checked = checked

            if not alive:
                break

            if checked >= max_iter:
                break

            time.sleep(0.05)
    finally:
        stop_event.set()
        for p in procs:
            p.join(timeout=0.5)
            if p.is_alive():
                p.terminate()

    elapsed = time.time() - start
    checked = total_progress(progress)
    if elapsed > 0:
        print(f"done checked={checked:,} elapsed={elapsed:.2f}s avg={checked/elapsed:,.0f}/s")

    if found:
        idx, uuid8_b64, uid16_b64, sid = found
        print("FOUND")
        print(f"  iter    = {idx}")
        print(f"  shortID = {sid}")
        print(f"  UUID8   = {uuid8_b64}")
        print(f"  UID16   = {uid16_b64}")
        return 0

    print("NOT FOUND: 增大 --max-iter 或更换 --seed")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Fast shortID/UID helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_inv = sub.add_parser("invert-uid16", help="直接把 UID16(Base64) 反解为 UUID8(Base64)")
    p_inv.add_argument("uid16", help="16字节 UID Base64")

    p_bf = sub.add_parser("bruteforce-shortid", help="多核穷举 3位 shortID -> UUID8")
    p_bf.add_argument("shortid", help="目标 shortID，例如 cnm")
    p_bf.add_argument("--seed", default="search", help="种子字符串（可复现）")
    p_bf.add_argument("--max-iter", type=int, default=50_000_000, help="最大尝试次数")
    p_bf.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 1) - 1), help="进程数")
    p_bf.add_argument("--report-every", type=int, default=20_000, help="每个进程累加进度间隔")

    args = parser.parse_args()

    if args.cmd == "invert-uid16":
        uuid8 = uid16_to_uuid8(args.uid16.strip())
        sid = shortid_from_uid16_b64(args.uid16.strip())
        print(f"UUID8   = {uuid8}")
        print(f"shortID = {sid}")
        return 0

    target = args.shortid.strip()
    if len(target) != 3:
        print("shortID 必须是 3 个字符")
        return 2
    return run_bruteforce(
        target=target,
        seed=args.seed,
        max_iter=args.max_iter,
        workers=max(1, args.workers),
        report_every=max(1, args.report_every),
    )


if __name__ == "__main__":
    raise SystemExit(main())
