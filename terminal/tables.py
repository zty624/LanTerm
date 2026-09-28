"""Bounded tabular previews; formulas are displayed, never evaluated."""

import csv
import io
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from defusedxml.common import DefusedXmlException
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from terminal.sessions import SessionError

ROWS = 500
COLS = 50
CELL = 2000
BOOK_LIMIT = 16 * 1024 * 1024
XML_LIMIT = 64 * 1024 * 1024


def table(rows, clipped: bool) -> dict:
    values = []
    for row in rows:
        if len(values) > ROWS:
            break
        cells = [str(value) if value is not None else "" for value in row]
        while cells and not cells[-1]:
            cells.pop()
        clipped |= len(cells) > COLS or any(len(value) > CELL for value in cells)
        values.append([value[:CELL] for value in cells[:COLS]])
    while values and not values[-1]:
        values.pop()
    clipped |= len(values) > ROWS
    return {
        "kind": "table",
        "rows": values[:ROWS],
        "truncated": clipped,
        "limits": {"rows": ROWS, "cols": COLS, "cell": CELL},
    }


def delimited(content: str, suffix: str, clipped: bool) -> dict:
    delimiter = "\t" if suffix == ".tsv" else ","
    if suffix == ".csv":
        try:
            delimiter = csv.Sniffer().sniff(content[:8192], delimiters=",;\t").delimiter
        except csv.Error:
            pass  # Ambiguous one-column files use the standard CSV delimiter.
    reader = csv.reader(io.StringIO(content, newline=""), delimiter=delimiter, strict=True)
    rows = []
    try:
        for row in reader:
            rows.append(row)
            if len(rows) > ROWS:
                break
    except csv.Error as exc:
        if not clipped:
            raise SessionError("表格格式不完整或单元格过大，无法预览", 422) from exc
    return {**table(rows, clipped), "sheets": [], "sheet": ""}


def workbook(stream, sheet: str, size: int) -> dict:
    if size > BOOK_LIMIT:
        raise SessionError("Excel 文件超过 16 MiB，暂不支持预览", 413)
    try:
        with ZipFile(stream) as archive:
            entries = archive.infolist()
            if len(entries) > 10000 or sum(item.file_size for item in entries) > XML_LIMIT:
                raise SessionError("Excel 解压后的内容过大，暂不支持预览", 413)
        stream.seek(0)
        book = load_workbook(stream, read_only=True, data_only=False, keep_links=False)
        try:
            names = [page.title for page in book.worksheets]
            if not names:
                raise SessionError("Excel 文件没有工作表", 422)
            name = sheet or names[0]
            if name not in names:
                raise SessionError("工作表不存在，请重新选择", 404)
            page = book[name]
            clipped = (page.max_row or 0) > ROWS or (page.max_column or 0) > COLS
            page.reset_dimensions()
            rows = page.iter_rows(max_row=ROWS + 1, max_col=COLS + 1, values_only=True)
            data = table(rows, clipped)
            return {**data, "sheets": names, "sheet": name, "note": "公式按原式显示，不计算"}
        finally:
            book.close()
    except (
        BadZipFile,
        InvalidFileException,
        ParseError,
        DefusedXmlException,
        KeyError,
        ValueError,
    ) as exc:
        raise SessionError("Excel 文件已损坏、已加密或格式不受支持", 422) from exc
