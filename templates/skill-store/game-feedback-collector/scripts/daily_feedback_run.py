#!/usr/bin/env python3
"""
每日定时采集反馈（方案 A：采集+预览通知，不自动写入飞书）。

流程：
  1. 从 state 读取上次游标 last_id，增量拉取正式服 game_feedback
  2. classify 分类
  3. dedup_and_preview 去重预览（只读飞书，不写入）
  4. 把本次运行摘要写入本地 SQLite（feedback_runs.db）
  5. 若有新增反馈（new>0）发飞书预览通知给负责人确认；否则静默
状态与结果都持久化在 skill 目录下。

用法:
  python3 scripts/daily_feedback_run.py [--dry] [--notify-to OPEN_ID] [--chat-id CHAT_ID] [--limit N]
"""
import argparse
import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent   # .../game-feedback-collector
STATE_FILE = SKILL_DIR / "daily_state.json"
DB_FILE = SKILL_DIR / "feedback_runs.db"
RAW_JSONL = SKILL_DIR / "daily_raw.jsonl"
CLS_JSONL = SKILL_DIR / "daily_classified.jsonl"
DEDUP_JSON = SKILL_DIR / "daily_dedup.json"

DEFAULT_CHAT_ID = "oc_2ffedace5f97b2e60824cc3b07851c82"   # 纪伟私聊


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


def run(cmd, stdin_text=None, cwd=None):
    res = subprocess.run(cmd, cwd=cwd or SKILL_DIR, input=stdin_text,
                         capture_output=True, text=True)
    return res.returncode, res.stdout, res.stderr


def get_conn():
    con = sqlite3.connect(DB_FILE)
    con.execute(
        """CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at TEXT NOT NULL,
            fetched INTEGER,
            accepted INTEGER,
            new INTEGER,
            skip INTEGER,
            conflict INTEGER,
            error INTEGER,
            details TEXT
        )"""
    )
    con.commit()
    return con


def record_run(con, run_at, fetched, accepted, summary, details):
    con.execute(
        "INSERT INTO runs (run_at, fetched, accepted, new, skip, conflict, error, details) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (run_at, fetched, accepted,
         summary.get("new", 0), summary.get("skip", 0),
         summary.get("conflict", 0), summary.get("error", 0),
         json.dumps(details, ensure_ascii=False)),
    )
    con.commit()


def notify_feishu(text, dry, notify_to=None, chat_id=None):
    target = ["--chat-id", chat_id or DEFAULT_CHAT_ID]
    if notify_to:
        target = ["--user-id", notify_to]
    if dry:
        print("[dry] 通知内容如下（未发送）：\n" + text)
        return 0, "", ""
    cmd = ["lark-cli", "im", "+messages-send", "--as", "user", "--text", text] + target
    code, out, err = run(cmd)
    return code, out, err


def parse_next_after_id(stderr):
    for line in stderr.splitlines():
        s = line.strip()
        if s.startswith("{"):
            try:
                meta = json.loads(s)
                return meta.get("nextAfterId")
            except Exception:
                continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="不真正发送通知")
    ap.add_argument("--notify-to", default=None, help="飞书 open_id，覆盖默认接收人")
    ap.add_argument("--chat-id", default=None, help="飞书 chat_id，覆盖默认会话")
    ap.add_argument("--limit", type=int, default=500)
    args = ap.parse_args()

    run_at = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    state = load_state()
    last_id = state.get("last_id") or 0

    # ---- 1. 增量拉取 ----
    code, raw, err = run(["node", "scripts/fetch_game_feedback.mjs",
                          "--after-id", str(last_id), "--limit", str(args.limit)])
    if code != 0:
        con = get_conn()
        record_run(con, run_at, 0, 0, {"new": 0, "skip": 0, "conflict": 0, "error": 1},
                   {"phase": "fetch", "error": err.strip()})
        con.close()
        print(f"[daily] fetch 失败 exit={code}: {err.strip()}", file=sys.stderr)
        sys.exit(1)

    RAW_JSONL.write_text(raw)
    next_id = parse_next_after_id(err)
    lines = [l for l in raw.splitlines() if l.strip()]
    fetched = len(lines)
    accepted = 0
    for l in lines:
        try:
            if json.loads(l).get("反馈内容"):
                accepted += 1
        except Exception:
            pass

    # ---- 2. 分类（stdin 读取）----
    code, cls_out, cls_err = run(["python3", "scripts/classify_feedback.py"], stdin_text=raw)
    if code != 0:
        print(f"[daily] classify 失败 exit={code}: {cls_err.strip()}", file=sys.stderr)
        sys.exit(1)
    CLS_JSONL.write_text(cls_out)

    # ---- 3. 去重预览（只读）----
    # 注意：dedup 对 conflict/searchError 会返回非零退出码，但这是正常的去重结果，
    # 不是致命错误。只要 stdout 有有效 JSON 就要继续（写库、更新游标、入列通知）。
    code, dedup_out, dedup_err = run(["node", "scripts/dedup_and_preview.mjs",
                                      "--input", str(CLS_JSONL)])
    DEDUP_JSON.write_text(dedup_out)

    summary = {"new": 0, "skip": 0, "conflict": 0, "error": 0}
    details = {"fetch_err": err.strip(), "dedup_log": dedup_err.strip()[-500:]}
    try:
        # dedup 的 stdout 是纯 JSON：{"summary": {...}, "results": [...]}
        parsed = json.loads(dedup_out)
        summary = parsed.get("summary", summary)
        details["pendingNew"] = [r.get("key") for r in parsed.get("results", [])
                                 if r.get("status") == "new"]
        details["conflicts"] = [r.get("key") for r in parsed.get("results", [])
                                if r.get("status") == "conflict"]
    except Exception as e:
        # stdout 无有效 JSON 才算 dedup 真的失败
        print(f"[daily] dedup 无有效输出 exit={code}: {dedup_err.strip()}", file=sys.stderr)
        details["dedup_parse_error"] = str(e)
        con = get_conn()
        record_run(con, run_at, fetched, accepted, summary, details)
        con.close()
        sys.exit(1)

    # ---- 4. 记录到本地 SQLite ----
    con = get_conn()
    record_run(con, run_at, fetched, accepted, summary, details)
    con.close()

    # ---- 5. 更新游标（仅当 fetch 成功且拿到 nextId）----
    if next_id is not None:
        state["last_id"] = int(next_id)
        save_state(state)

    print(f"[daily] fetched={fetched} accepted={accepted} "
          f"new={summary['new']} skip={summary['skip']} "
          f"conflict={summary['conflict']} error={summary['error']} "
          f"next_id={next_id}")

    # ---- 6. 有新反馈才发预览通知 ----
    if summary["new"] > 0:
        lines_text = "\n".join(
            f"• {r.get('key')} {r.get('反馈分类') or ''} {r.get('情感倾向') or ''} | {r.get('内容预览') or ''}"
            for r in json.loads(DEDUP_JSON.read_text()).get("results", [])
            if r.get("status") == "new"
        )[:2000]
        text = (f"📋 每日反馈采集（{run_at[:10]}）\n"
                f"增量拉取 {fetched} 条，其中「新增待写入」{summary['new']} 条，"
                f"跳过 {summary['skip']}，冲突 {summary['conflict']}，查重失败 {summary['error']}。\n"
                f"新增待确认：\n{lines_text}\n"
                f"回复「确认写入」即可由我写入飞书反馈表。")
        code, out, err = notify_feishu(text, args.dry, args.notify_to, args.chat_id)
        if code != 0:
            print(f"[daily] 通知失败 exit={code}: {err.strip()}", file=sys.stderr)
        else:
            print("[daily] 已发送飞书预览通知")
    else:
        print("[daily] 无新增反馈，跳过通知")


if __name__ == "__main__":
    main()