"""Pure, conservative classification for one game-feedback message and JSONL CLI."""

import json
import re
import sys


BLOCKER = "阻断性BUG "
FUNCTION = "功能问题"
SUGGESTION = "玩法建议"
UNCLASSIFIED = "未分类"
NPC = "NPC相关 "
ONBOARDING = "新手引导"
STORY = "事件&剧情"

ACCESS_FAILURE_TERMS = (
    "下载失败", "登录失败", "登陆失败", "下载不了", "无法下载",
    "登录不上", "无法登录", "不能登录",
    "进不去游戏", "无法进入游戏", "进入不了游戏", "游戏进不去", "游戏无法进入",
)
BLOCKER_TERMS = (
    "黑屏", "闪退", "崩溃", "卡死", "卡住", "卡在", "无法继续", "进不去",
    "无法进入", "进入不了", "无法绕过", *ACCESS_FAILURE_TERMS,
)
FUNCTION_TERMS = (
    "叫成", "显示错误", "显示不对", "异常", "失效", "没反应", "无响应",
    "无法使用", "不能使用", "掉帧", "丢失", "不一致", "卡顿", "bug", "错误",
)
REQUEST_ACTION_TERMS = (
    "增加", "新增", "优化", "改进", "修复", "调整", "删除",
)
SUGGESTION_TERMS = (
    "建议", "希望", *REQUEST_ACTION_TERMS, "想要", "如何", "怎么", "不知道",
    "不会", "能不能", "不清楚", "规则不明", "说明不足",
)
NPC_TOPIC_TERMS = (
    "npc", "结婚", "角色", "人物", "对话", "称谓", "称呼", "性别", "关系",
    "亲密度", "外观",
)
ONBOARDING_TOPIC_TERMS = (
    "如何", "怎么", "不知道", "不会", "新手", "引导", "教程", "规则不明",
    "首次流程", "说明不足",
)
STORY_TOPIC_TERMS = (
    "剧情", "事件", "主线", "章节", "故事",
)
STORY_FLOW_CONTEXT_TERMS = (
    "任务", "地点", "场景",
)
GENERAL_EVALUATION_SUBJECT_TERMS = (
    "游戏", "整体体验",
)
GENERAL_EVALUATION_PRAISE_TERMS = (
    "不错", "好玩", "优秀", "很棒",
)

# 情感判断词表。负面词覆盖 BLOCKER_TERMS / FUNCTION_TERMS 中的明显负面表达；
# 正面词用于明确表扬。其余文本按中性处理。
NEGATIVE_SENTIMENT_TERMS = (
    *BLOCKER_TERMS,
    "丢失", "失效", "错误", "异常", "崩溃", "卡顿", "bug",
    "烂", "差", "失望", "烦", "气", "槽糕", "难用", "坑",
)
POSITIVE_SENTIMENT_TERMS = (
    "不错", "好玩", "优秀", "很棒", "喜欢", "棒", "超爱",
    "赞", "好用", "精彩", "满意",
)
GENERAL_OBJECT_TERMS = (
    "游戏", "画面", "界面", "按钮", "按键", "功能", "状态", "声音", "音效",
    "音乐", "文本", "翻译", "性能", "帧率", "卡顿", "问题", "体验", "操作",
    "设置", "存档", "奖励", "数值", "战斗", "任务", "地图", "地点", "场景",
    "加载", "下载", "登录",
)


def _clean_text(content):
    """Coerce arbitrary input into comparable, compact text."""
    if content is None:
        return ""
    return re.sub(r"\s+", " ", str(content)).strip().casefold()


def _has_any(text, terms):
    return any(term in text for term in terms)


def _detect_topics(text, main):
    topics = []
    # NPC 名词（角色/人物/对话/称谓等）较泛，纯外观表扬如"角色真好看""NPC真好看"
    # 不应触发 NPC 专题。仅当 main 已判定为具体问题性质（非未分类）时才追加 NPC 专题，
    # 避免裸名词+表扬被误判为 NPC 相关。（STORY/ONBOARDING 名词更具体，保持原判定。）
    if main != UNCLASSIFIED and _has_any(text, NPC_TOPIC_TERMS):
        topics.append(NPC)
    if _has_any(text, ONBOARDING_TOPIC_TERMS):
        topics.append(ONBOARDING)
    if _has_any(text, STORY_TOPIC_TERMS) or (
        main == BLOCKER and _has_any(text, STORY_FLOW_CONTEXT_TERMS)
    ):
        topics.append(STORY)
    return topics


def _is_general_evaluation(text):
    return _has_any(text, GENERAL_EVALUATION_SUBJECT_TERMS) and _has_any(
        text, GENERAL_EVALUATION_PRAISE_TERMS
    )


def _detect_main_category(text):
    if _is_access_failure(text):
        return BLOCKER
    if _has_any(text, BLOCKER_TERMS):
        return BLOCKER
    if _has_any(text, FUNCTION_TERMS):
        return FUNCTION
    if _has_any(text, SUGGESTION_TERMS) or _is_general_evaluation(text):
        return SUGGESTION
    return UNCLASSIFIED


def _is_access_failure(text):
    return _has_any(text, ACCESS_FAILURE_TERMS)


def _detect_sentiment(text):
    """Infer sentiment from content; used only when no App Store rating exists."""
    if _has_any(text, NEGATIVE_SENTIMENT_TERMS):
        return "负面"
    if _has_any(text, POSITIVE_SENTIMENT_TERMS):
        return "正面"
    return "中性"


def _has_concrete_request(text):
    return _has_any(text, GENERAL_OBJECT_TERMS) and (
        _has_any(text, FUNCTION_TERMS) or _has_any(text, REQUEST_ACTION_TERMS)
    )


def _choose_owner_route(main, topics, text):
    if _is_access_failure(text):
        return "access"
    if len(topics) > 1:
        return None
    if main == BLOCKER and topics == [STORY]:
        return "story_flow"
    if main not in (BLOCKER, UNCLASSIFIED) and topics == [NPC]:
        return "npc"
    if main == SUGGESTION and topics == [ONBOARDING]:
        return "onboarding"
    if not topics and main == SUGGESTION and _has_concrete_request(text):
        return "suggestion"
    if not topics and main == FUNCTION and _has_concrete_request(text):
        return "general"
    return None


def _ordered_categories(main, topics):
    if main == UNCLASSIFIED:
        return topics if topics else [UNCLASSIFIED]
    fixed_topics = [topic for topic in (NPC, ONBOARDING, STORY) if topic in topics]
    return [main, *fixed_topics]


def classify_feedback(content: object) -> dict:
    """Classify feedback and return only a non-personal routing recommendation."""
    text = _clean_text(content)
    main = _detect_main_category(text)
    topics = _detect_topics(text, main)
    owner_route = _choose_owner_route(main, topics, text)
    needs_review = main == UNCLASSIFIED or owner_route is None
    return {
        "categories": _ordered_categories(main, topics),
        "owner_route": owner_route,
        "confidence": "low" if needs_review else "high",
        "needs_review": needs_review,
        "reason": [
            f"main:{main}",
            *(f"topic:{topic}" for topic in topics),
            f"route:{owner_route or 'review'}",
        ],
    }


def enrich_record(record: dict) -> dict:
    """Add write-preparation classification without touching the owner field."""
    # 分类阶段优先读翻译后的 _分类内容（若有），否则回落到原文 反馈内容。
    # 写入飞书时 反馈内容 始终为原文，翻译字段仅用于分类。
    content = record.get("_分类内容") or record.get("反馈内容")
    if not _clean_text(content):
        raise ValueError("反馈内容不能为空")
    text = _clean_text(content)
    decision = classify_feedback(content)
    enriched = {
        **record,
        "反馈分类": decision["categories"],
        "_分类判定": decision,
    }
    # 情感倾向：仅当原 record 没有值（null）时填充，避免覆盖 App Store rating 推导的情感。
    if not record.get("情感倾向"):
        enriched["情感倾向"] = _detect_sentiment(text)
    return enriched


def _input_lines(arguments):
    if len(arguments) == 0:
        return sys.stdin
    if len(arguments) == 1:
        return open(arguments[0], encoding="utf-8")
    raise ValueError("最多只能指定一个 JSONL 输入路径")


def main(arguments=None) -> int:
    """Read JSONL from stdin or one path and write classified JSONL to stdout."""
    arguments = sys.argv[1:] if arguments is None else arguments
    try:
        with _input_lines(arguments) as source:
            for line in source:
                if not line.strip():
                    continue
                record = json.loads(line)
                print(json.dumps(enrich_record(record), ensure_ascii=False))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
