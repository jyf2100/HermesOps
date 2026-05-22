"""
Dispatch Confirm Tool — confirms or rejects an admin-dispatched task.

When the admin backend dispatches a task through the orchestrator, the agent
receives dispatch metadata (callback_url, callback_token, assignment_id).
This tool calls back to the admin backend to record the user's confirmation
or rejection.
"""

import json
import logging

import httpx

logger = logging.getLogger("hermes.dispatch_confirm")

DISPATCH_CONFIRM_SCHEMA = {
    "type": "function",
    "function": {
        "name": "dispatch_confirm",
        "description": (
            "确认或拒绝管理员分派的任务。收到管理员通过后台下发的任务时，"
            "使用此工具向系统回报你的决定。确认后系统会通知管理员任务已接受。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["confirm", "reject"],
                    "description": "确认接受或拒绝任务",
                },
                "profile_name": {
                    "type": "string",
                    "description": "确认时选择的 profile 名称（可选）",
                },
                "reason": {
                    "type": "string",
                    "description": "拒绝原因（可选）",
                },
            },
            "required": ["action"],
        },
    },
}


def dispatch_confirm_handler(args: dict, *, metadata: dict | None = None) -> str:
    if not metadata or "callback_url" not in metadata:
        return json.dumps({"status": "skipped", "message": "无分派元数据，跳过确认"})

    callback_url = metadata["callback_url"]
    assignment_id = metadata.get("dispatch_assignment_id")
    token = metadata.get("callback_token")

    if not assignment_id or not token:
        return json.dumps({"status": "error", "message": "分派信息不完整"})

    action = args.get("action", "")

    if action == "confirm":
        url = callback_url.replace("/result", "/confirm")
        payload = {
            "assignment_id": assignment_id,
            "callback_token": token,
            "profile_name": args.get("profile_name"),
            "profile_source": "dispatch",
        }
    elif action == "reject":
        url = callback_url.replace("/result", "/reject")
        payload = {
            "assignment_id": assignment_id,
            "callback_token": token,
            "reason": args.get("reason", ""),
        }
    else:
        return json.dumps({"status": "error", "message": f"无效 action: {action}"})

    try:
        resp = httpx.post(url, json=payload, timeout=10)
        return json.dumps(resp.json())
    except httpx.ConnectError:
        logger.warning("dispatch_confirm: cannot reach %s", url)
        return json.dumps({"status": "error", "message": f"无法连接回调地址: {url}"})
    except Exception as exc:
        logger.warning("dispatch_confirm: callback failed: %s", exc)
        return json.dumps({"status": "error", "message": str(exc)[:200]})


# --- Registry ---
from tools.registry import registry

registry.register(
    name="dispatch_confirm",
    toolset="dispatch",
    schema=DISPATCH_CONFIRM_SCHEMA,
    handler=lambda args, **kw: dispatch_confirm_handler(args, metadata=kw.get("metadata")),
    check_fn=lambda: False,  # dynamically injected by AIAgent when metadata present
    emoji="📋",
)
