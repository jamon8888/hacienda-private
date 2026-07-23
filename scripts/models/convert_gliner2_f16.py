#!/usr/bin/env python3
"""Convert a GLiNER2 safetensors checkpoint to a browser F16 artifact.

The source checkpoint is F32. This conversion is intentionally explicit rather
than performed in the browser: it halves download/storage cost and avoids a
second full-size copy during startup. Requires ``safetensors`` and ``numpy``.

Example:
  python3 scripts/models/convert_gliner2_f16.py model.safetensors gliner2-base-f16.safetensors

After publishing the output, record its SHA256 and byte size in the model
manifest before enabling it as the browser default.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import numpy as np
from safetensors.numpy import load_file, save_file


def convert(source: Path, destination: Path) -> tuple[str, int]:
    tensors = load_file(str(source), device="cpu")
    converted = {
        name: value.astype(np.float16, copy=False) if np.issubdtype(value.dtype, np.floating) else value
        for name, value in tensors.items()
    }
    save_file(converted, str(destination), metadata={"source": source.name, "precision": "f16"})
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
