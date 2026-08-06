#!/usr/bin/env python3
"""Normalize mobile-game feedback into the legacy Feishu table schema."""

import argparse
import csv
import hashlib
import io
import json
import re
import sys


FIELDS = [
    "去重键",
    "反馈时间",
    "反馈内容",
    "反馈内容翻译",
    "情感倾向",
    "反馈分类",
    "来源",
    "图片链接",
    "客户端版本",
    "系统版本",
    "设备型号",
    "负责人 (人员 )",
]

ALIASES = {
    "content": "反馈内容",
    "feedback": "反馈内容",
    "translation": "反馈内容翻译",
    "submitted_at": "反馈时间",
    "source": "来源",
    "client_version": "客户端版本",
    "os_version": "系统版本",
    "device": "设备型号",
    "image": "图片链接",
    "category": "反馈分类",
    "sentiment": "情感倾向",
    "dedupe_key": "去重键",
}


def clean_text(value):
    """Return a compact string while preserving its semantic content."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def make_dedupe_key(record):
    """Use an upstream record ID when available, otherwise hash content."""
    existing = clean_text(record.get("去重键"))
    if existing:
        return existing
    source_id = clean_text(record.get("source_id"))
    if source_id:
        return f"db:{source_id}"
    content = clean_text(record.get("反馈内容") or record.get("content"))
    if not content:
        raise ValueError("反馈内容不能为空")
    digest = hashlib.sha256(content.casefold().encode("utf-8")).hexdigest()[:8]
    return f"hp:{digest}"


def normalize_images(value, dedupe_key):
    """Validate 图片链接 as a JSON URL array, mirroring game_feedback_db.mjs.

    Returns (normalized_value, warnings). Empty/None → (None, []). Valid JSON
    string array → (serialized_string, []). Otherwise the original value is
    preserved and a warning is collected so the row can still be written.
    """
    if value is None or value == "":
        return None, []
    raw = str(value)
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return raw, [
            f"{dedupe_key} 图片链接不是有效的 JSON，已保留原值"
        ]
    if not isinstance(parsed, list) or any(
        not isinstance(item, str) for item in parsed
    ):
        return raw, [
            f"{dedupe_key} 图片链接不是 JSON 字符串数组，已保留原值"
        ]
    return json.dumps(parsed, ensure_ascii=False), []


def normalize_record(record):
    """Map aliases, validate content, and return only legacy fields.

    Image link validation warnings are printed to stderr; the field value is
    preserved (or set to None when empty) so the record can still be written.
    """
    mapped = {ALIASES.get(str(key), str(key)): value for key, value in record.items()}
    mapped["反馈内容"] = clean_text(mapped.get("反馈内容"))
    if not mapped["反馈内容"]:
        raise ValueError("反馈内容不能为空")
    mapped["去重键"] = make_dedupe_key({**record, **mapped})

    image_value, image_warnings = normalize_images(
        mapped.get("图片链接"), mapped["去重键"]
    )
    for warning in image_warnings:
        print(f"warning: {warning}", file=sys.stderr)

    result = {field: (mapped.get(field) or None) for field in FIELDS}
    # 图片链接已单独校验，覆盖 or None 的默认行为（保留原值或序列化后的 JSON 字符串）。
    result["图片链接"] = image_value
    return result


def normalize_records(records):
    """Normalize records and remove duplicate dedupe keys in input order."""
    output = []
    seen = set()
    for record in records:
        item = normalize_record(record)
        if item["去重键"] not in seen:
            output.append(item)
            seen.add(item["去重键"])
    return output


def parse_input(text, input_format):
    """Parse supported text formats into dictionaries."""
    if input_format == "text":
        return [{"反馈内容": text}]
    if input_format == "csv":
        return list(csv.DictReader(io.StringIO(text)))
    if input_format == "json":
        value = json.loads(text)
        return value if isinstance(value, list) else [value]
    if input_format == "jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    raise ValueError(f"不支持的输入格式: {input_format}")


def main():
    parser = argparse.ArgumentParser(
        description="Normalize feedback to legacy Feishu JSONL."
    )
    parser.add_argument("path", nargs="?")
    parser.add_argument("--format", choices=["text", "csv", "json", "jsonl"])
    args = parser.parse_args()

    if args.path:
        with open(args.path, encoding="utf-8-sig") as source:
            text = source.read()
    else:
        text = sys.stdin.read()

    suffix = args.path.rsplit(".", 1)[-1].lower() if args.path and "." in args.path else ""
    input_format = args.format or (suffix if suffix in {"csv", "json", "jsonl"} else "text")
    for item in normalize_records(parse_input(text, input_format)):
        print(json.dumps(item, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
