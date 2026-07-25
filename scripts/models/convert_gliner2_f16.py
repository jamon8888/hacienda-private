#!/usr/bin/env python3
"""Convert a GLiNER2 safetensors checkpoint to a browser F16 artifact.

The source checkpoint is F32. This conversion is intentionally explicit rather
than performed in the browser: it halves download/storage cost and avoids a
second full-size copy during startup. Requires ``numpy`` only and streams one
tensor at a time from the source mmap.

Example:
  python3 scripts/models/convert_gliner2_f16.py model.safetensors gliner2-base-f16.safetensors

After publishing the output, record its SHA256 and byte size in the model
manifest before enabling it as the browser default.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mmap
import struct
from pathlib import Path

import numpy as np
def convert(source: Path, destination: Path) -> tuple[str, int]:
    with source.open("rb") as source_file, mmap.mmap(source_file.fileno(), 0, access=mmap.ACCESS_READ) as source_map:
        header_size = struct.unpack_from("<Q", source_map, 0)[0]
        header = json.loads(source_map[8 : 8 + header_size])
        output_header: dict[str, object] = {"__metadata__": {"source": source.name, "precision": "f16"}}
        output_offset = 0
        for name, info in header.items():
            if name == "__metadata__":
                continue
            start, end = info["data_offsets"]
            dtype = info["dtype"]
            source_bytes = end - start
            output_bytes = source_bytes // 2 if dtype == "F32" else source_bytes
            output_header[name] = {
                "dtype": "F16" if dtype == "F32" else dtype,
                "shape": info["shape"],
                "data_offsets": [output_offset, output_offset + output_bytes],
            }
            output_offset += output_bytes

        encoded_header = json.dumps(output_header, separators=(",", ":")).encode()
        encoded_header += b" " * ((8 - ((8 + len(encoded_header)) % 8)) % 8)
        with destination.open("wb") as output:
            output.write(struct.pack("<Q", len(encoded_header)))
            output.write(encoded_header)
            data_start = 8 + header_size
            for name, info in header.items():
                if name == "__metadata__":
                    continue
                start, end = info["data_offsets"]
                raw = memoryview(source_map)[data_start + start : data_start + end]
                if info["dtype"] == "F32":
                    output.write(np.frombuffer(raw, dtype="<f4").astype("<f2").tobytes())
                else:
                    output.write(raw)
                raw.release()
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    return digest, destination.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    digest, size = convert(args.source, args.destination)
    print(f"sha256={digest}")
    print(f"bytes={size}")


if __name__ == "__main__":
    main()
