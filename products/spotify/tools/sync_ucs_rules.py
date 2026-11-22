#!/usr/bin/env python3
"""Đồng bộ danh sách UCS property replacement từ EeveeSpotifyReincarnated.

Nguồn: SideloadLabs/EeveeSpotifyReincarnated (GPL-3.0),
       Sources/EeveeSpotify/Premium/DynamicPremium+ModifyingFunctions.swift
       -> `private let propertyReplacements = [...]`

Sinh ra:
  products/spotify/data/ucs-rules.json      (dữ liệu có thể diff / review)
  và thay khối GENERATED RULES trong products/spotify/on-device/engine/spotify_ucs.js

Cách dùng:
  git clone --depth 1 https://github.com/SideloadLabs/EeveeSpotifyReincarnated /tmp/eevee
  python3 products/spotify/tools/sync_ucs_rules.py /tmp/eevee

Tại sao cần: rule mới được upstream thêm liên tục (219 -> 260 rule trong một
khoảng thời gian ngắn). Chép tay sẽ lệch ngay lập tức.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DATA_OUT = os.path.join(ROOT, "products", "spotify", "data", "ucs-rules.json")
SCRIPT_OUT = os.path.join(ROOT, "products", "spotify", "on-device", "engine", "spotify_ucs.js")

SWIFT_REL = "Sources/EeveeSpotify/Premium/DynamicPremium+ModifyingFunctions.swift"

BEGIN_MARK = "// BEGIN GENERATED RULES"
END_MARK = "// END GENERATED RULES"


def find_balanced(text, start, open_ch="[", close_ch="]"):
    """Trả về đoạn text từ `start` tới ký tự đóng cân bằng."""
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError("unbalanced brackets")


def split_entries(array_literal):
    """Tách các lời gọi EeveePropertyReplacement(...) ở cấp ngoài cùng."""
    body = array_literal[1:-1]
    entries, depth, cur = [], 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        if depth > 0:
            cur += ch
        if ch == ")":
            depth -= 1
            if depth == 0:
                entries.append(cur)
                cur = ""
    return entries


def parse_value(raw):
    raw = (raw or "").strip()
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    if raw in ("true", "false"):
        return raw == "true"
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    return raw


def resolve_token(token, resolved, field):
    """Đổi `"literal"` hoặc `ServerSidedFeaturePolicy.xyz.name` thành chuỗi."""
    if token is None:
        return None
    token = token.strip()
    if token.startswith('"') and token.endswith('"'):
        return token[1:-1]
    key = token[: -len(".name")] if token.endswith(".name") else token
    key = key[: -len(".scope")] if key.endswith(".scope") else key
    return resolved.get(key, {}).get(field, token)


def parse_swift(path):
    src = open(path, encoding="utf-8").read()
    anchor = src.index("private let propertyReplacements = [")
    start = src.index("[", anchor)
    literal = find_balanced(src, start)

    # Một vài entry dùng hằng số thay vì literal, vd:
    #   name: ServerSidedFeaturePolicy.premiumGatedJamEntryPoint.name,
    #   scope: ServerSidedFeaturePolicy.premiumGatedJamEntryPoint.scope
    # -> resolve từ file ServerSidedFeaturePolicy.swift ở bước sau.
    resolved = resolve_remote_flags_from_file(
        os.path.join(os.path.dirname(path), "Helpers", "ServerSidedFeaturePolicy.swift")
    )

    rules = []
    for entry in split_entries(literal):
        name = re.search(r'name:\s*"([^"]+)"', entry)
        scope = re.search(r'scope:\s*"([^"]+)"', entry)
        if not name:
            name = re.search(r"name:\s*([\w.]+)", entry)
        if not scope:
            scope = re.search(r"scope:\s*([\w.]+)", entry)
        mod = re.search(r"modification:\s*\.(\w+)(?:\(([^)]*)\))?", entry)
        if not mod:
            # Bình luận lọt vào vùng quét, không phải rule.
            continue

        rule_name = resolve_token(name.group(1) if name else None, resolved, "name")
        rule_scope = resolve_token(scope.group(1) if scope else None, resolved, "scope")

        # Rule không có cả name lẫn scope sẽ áp lên mọi AssignedValue - gần như
        # chắc chắn là lỗi parse, không phải rule thật.
        if rule_name is None and rule_scope is None:
            raise ValueError(f"rule không xác định được name/scope: {entry[:120]}")

        rules.append(
            {
                "name": rule_name,
                "scope": rule_scope,
                "action": mod.group(1),
                "value": parse_value(mod.group(2)),
            }
        )
    return rules, src


def resolve_remote_flags_from_file(path):
    flags = {}
    if not os.path.exists(path):
        return flags
    text = open(path, encoding="utf-8").read()
    for m in re.finditer(
        r"static let (\w+) = RemoteFlag\(\s*scope:\s*\"([^\"]+)\",\s*name:\s*\"([^\"]+)\"",
        text,
    ):
        flags[f"ServerSidedFeaturePolicy.{m.group(1)}"] = {
            "name": m.group(3),
            "scope": m.group(2),
        }
    return flags


def server_authoritative(src):
    """Các attribute do server quyết định - không được spoof (Eevee bỏ qua)."""
    anchor = src.index("serverAuthoritativeAccountAttributes")
    literal = find_balanced(src, src.index("[", anchor))
    return re.findall(r'"([^"]+)"', literal)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    repo = sys.argv[1]
    swift_path = os.path.join(repo, SWIFT_REL)
    rules, _ = parse_swift(swift_path)

    # Metadata server-authoritative đọc từ file policy riêng.
    policy_path = os.path.join(
        repo, "Sources/EeveeSpotify/Premium/Helpers/ServerSidedFeaturePolicy.swift"
    )
    authoritative = server_authoritative(open(policy_path, encoding="utf-8").read())

    counts = {}
    for r in rules:
        counts[r["action"]] = counts.get(r["action"], 0) + 1

    payload = {
        "_comment": (
            "Sinh tự động bởi products/spotify/tools/sync_ucs_rules.py - KHÔNG sửa tay."
        ),
        "_source": {
            "repo": "SideloadLabs/EeveeSpotifyReincarnated",
            "file": SWIFT_REL,
            "license": "GPL-3.0",
        },
        "counts": counts,
        "server_authoritative_attributes": authoritative,
        "rules": rules,
    }

    os.makedirs(os.path.dirname(DATA_OUT), exist_ok=True)
    with open(DATA_OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    # Nhúng vào script Shadowrocket (script phải tự chứa, không fetch file rời).
    compact = [[r["name"], r["scope"], r["action"], r["value"]] for r in rules]
    block = (
        f"{BEGIN_MARK} (sinh bởi tools/sync_ucs_rules.py - KHÔNG sửa tay)\n"
        f"var UCS_RULES = {json.dumps(compact, ensure_ascii=False, indent=0)};\n"
        f"var SERVER_AUTHORITATIVE_ATTRIBUTES = {json.dumps(authoritative, ensure_ascii=False)};\n"
        f"{END_MARK}"
    )

    script = open(SCRIPT_OUT, encoding="utf-8").read()
    pre = script.index(BEGIN_MARK)
    post = script.index(END_MARK) + len(END_MARK)
    open(SCRIPT_OUT, "w", encoding="utf-8").write(script[:pre] + block + script[post:])

    print(f"rules: {len(rules)} {counts}")
    print(f"server-authoritative: {len(authoritative)}")
    print(f"-> {DATA_OUT}")
    print(f"-> {SCRIPT_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
