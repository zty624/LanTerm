"""Small real documents and media for preview integration tests."""

import argparse
import math
import struct
import subprocess
import wave
from pathlib import Path

from openpyxl import Workbook


def pdf() -> bytes:
    drawing = (
        b"0.12 0.2 0.16 rg 0 0 640 480 re f\n"
        b"BT /F1 28 Tf 0.65 0.9 0.75 rg 50 365 Td (LanTerm PDF preview) Tj ET\n"
        b"BT /F1 16 Tf 1 1 1 rg 50 320 Td "
        b"(Search, zoom and read documents in your browser.) Tj ET\n"
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 480] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(drawing)} >>\nstream\n".encode() + drawing + b"endstream",
    ]
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(data)
    data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode())
    data.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    )
    return bytes(data)


def create(folder: Path, video: bool) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "report.pdf").write_bytes(pdf())
    (folder / "results.csv").write_text(
        'name,score,note\nalpha,0.91,"hello, world"\n'
        'beta,0.85,"two\nlines"\n<script>alert(1)</script>,0,safe text\n'
    )
    (folder / "results.tsv").write_text("name\tcount\n任务 A\t12\n任务 B\t9\n")
    book = Workbook()
    first = book.active
    first.title = "指标"
    first.append(["metric", "value", "note"])
    first.append(["accuracy", 0.91, "validation"])
    first.append(["loss", 0.12, "training"])
    second = book.create_sheet("明细")
    second.append(["step", "value"])
    second.append([1, "=2+3"])
    book.save(folder / "results.xlsx")
    book.close()
    with wave.open(str(folder / "tone.wav"), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(
            b"".join(
                struct.pack("<h", round(2000 * math.sin(i * 2 * math.pi * 440 / 8000)))
                for i in range(24000)
            )
        )
    if video:
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=12",
                "-t",
                "3",
                "-c:v",
                "libvpx",
                "-pix_fmt",
                "yuv420p",
                "-y",
                str(folder / "clip.webm"),
            ],
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("--video", action="store_true")
    args = parser.parse_args()
    create(args.folder, args.video)
