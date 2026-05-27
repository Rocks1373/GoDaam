import secrets
from typing import Any, Optional, Dict

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from .agent import AgentError, decide_tool
from .api_client import BackendClient, BackendClientConfig
from .config import get_settings
from .db import Db, DbConfig
from .logger import ActionLogger, AiLogEntry
from .tools import DANGEROUS_TOOLS, ToolContext, ToolError, run_tool


settings = get_settings()
db = Db(DbConfig(path=settings.db_path))
backend = BackendClient(BackendClientConfig(base_url=settings.backend_base_url, jwt=settings.backend_jwt))
ctx = ToolContext(db=db, backend=backend, auto_fix=settings.auto_fix)
action_logger = ActionLogger(db=db)

app = FastAPI(title="GoDam AI Plugin", version="0.1.0")


def _require_secret(x_ai_plugin_secret: Optional[str]) -> None:
    if not settings.shared_secret:
        return
    got = (x_ai_plugin_secret or "").strip()
    if not got or not secrets.compare_digest(got, settings.shared_secret):
        raise HTTPException(status_code=403, detail="Invalid AI plugin secret")


class UserInfo(BaseModel):
    id: Optional[int] = None
    username: Optional[str] = None
    role: Optional[str] = None

    @classmethod
    def _coerce_id(cls, v: Any) -> Optional[int]:
        if v is None or v == "":
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    @classmethod
    def model_validate(cls, obj: Any, **kwargs: Any) -> "UserInfo":
        if isinstance(obj, dict) and "id" in obj:
            obj = {**obj, "id": cls._coerce_id(obj.get("id"))}
        return super().model_validate(obj, **kwargs)


class ChatRequest(BaseModel):
    command: str
    context: dict[str, Any] = {}
    confirm_token: Optional[str] = None
    user: Optional[UserInfo] = None
    request_meta: dict[str, Any] = {}


class RunToolRequest(BaseModel):
    tool_name: str
    tool_args: dict[str, Any] = {}
    confirm_token: Optional[str] = None
    user: Optional[UserInfo] = None


class CheckOrdersRequest(BaseModel):
    mode: str = "manual"


def _log(
    user: Optional[UserInfo],
    command: Optional[str],
    tool_name: Optional[str],
    tool_args: Optional[Dict[str, Any]],
    result: Optional[Any],
    status: str,
    error: Optional[str] = None,
) -> None:
    action_logger.log(
        AiLogEntry(
            user_id=user.id if user else None,
            username=user.username if user else None,
            role=user.role if user else None,
            command=command,
            tool_name=tool_name,
            tool_args=tool_args,
            result=result,
            status=status,
            error_message=error,
        )
    )


@app.post("/chat")
def chat(req: ChatRequest, x_ai_plugin_secret: str = Header(default=None)) -> dict[str, Any]:  # type: ignore[assignment]
    _require_secret(x_ai_plugin_secret)
    command = req.command.strip()
    if not command:
        raise HTTPException(status_code=400, detail="command is required")

    try:
        decision = decide_tool(settings, command, req.context)
    except AgentError as e:
        _log(req.user, command, None, None, {"error": str(e)}, "error", str(e))
        raise HTTPException(status_code=400, detail=str(e))

    if decision.tool_name == "answer_from_memory":
        answer = str(decision.tool_args.get("answer") or decision.summary).strip()
        out = {
            "ok": True,
            "tool_name": decision.tool_name,
            "tool_args": decision.tool_args,
            "summary": answer,
            "result": {
                "answer": answer,
                "topics": decision.tool_args.get("topics") or [],
            },
        }
        _log(req.user, command, decision.tool_name, decision.tool_args, out, "ok")
        return out

    # Confirmation gate: dangerous tools ALWAYS require confirm_token.
    if decision.tool_name in DANGEROUS_TOOLS and not req.confirm_token:
        out = {
            "ok": False,
            "needs_confirmation": True,
            "tool_name": decision.tool_name,
            "tool_args": decision.tool_args,
            "confirmation_reason": decision.confirmation_reason
            or f"Tool '{decision.tool_name}' can change state. Re-run with confirm_token to proceed.",
            "summary": decision.summary,
        }
        _log(req.user, command, decision.tool_name, decision.tool_args, out, "ok")
        return out

    # Execute tool
    try:
        result = run_tool(ctx, decision.tool_name, decision.tool_args)
        out = {
            "ok": True,
            "tool_name": decision.tool_name,
            "tool_args": decision.tool_args,
            "summary": decision.summary,
            "result": result,
        }
        _log(req.user, command, decision.tool_name, decision.tool_args, out, "ok")
        return out
    except ToolError as e:
        out = {"ok": False, "error": str(e), "tool_name": decision.tool_name, "tool_args": decision.tool_args}
        _log(req.user, command, decision.tool_name, decision.tool_args, out, "error", str(e))
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/run-tool")
def run_tool_endpoint(req: RunToolRequest, x_ai_plugin_secret: str = Header(default=None)) -> dict[str, Any]:  # type: ignore[assignment]
    _require_secret(x_ai_plugin_secret)
    tool_name = req.tool_name.strip()

    if tool_name in DANGEROUS_TOOLS and not req.confirm_token:
        out = {
            "ok": False,
            "needs_confirmation": True,
            "tool_name": tool_name,
            "tool_args": req.tool_args,
            "confirmation_reason": f"Tool '{tool_name}' can change state. Provide confirm_token to proceed.",
        }
        _log(req.user, None, tool_name, req.tool_args, out, "ok")
        return out

    try:
        result = run_tool(ctx, tool_name, req.tool_args)
        out = {"ok": True, "tool_name": tool_name, "tool_args": req.tool_args, "result": result}
        _log(req.user, None, tool_name, req.tool_args, out, "ok")
        return out
    except ToolError as e:
        out = {"ok": False, "error": str(e), "tool_name": tool_name, "tool_args": req.tool_args}
        _log(req.user, None, tool_name, req.tool_args, out, "error", str(e))
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/check-orders")
def check_orders(req: CheckOrdersRequest, x_ai_plugin_secret: str = Header(default=None)) -> dict[str, Any]:  # type: ignore[assignment]
    _require_secret(x_ai_plugin_secret)
    # Minimal periodic checks -> returns reports.
    pending = run_tool(ctx, "generate_report", {"report_type": "pending_delivery_report", "limit": 200})
    gapp_issues = run_tool(ctx, "generate_report", {"report_type": "gapp_confirmation_issue_report", "limit": 200})
    notif_issues = run_tool(ctx, "generate_report", {"report_type": "notification_failure_report", "limit": 200})
    mismatch = run_tool(ctx, "generate_report", {"report_type": "mismatch_report", "limit": 200})
    missing_driver = run_tool(ctx, "generate_report", {"report_type": "missing_driver_report", "limit": 200})
    return {
        "ok": True,
        "mode": req.mode,
        "reports": {
            "pending_delivery_report": pending,
            "mismatch_report": mismatch,
            "missing_driver_report": missing_driver,
            "gapp_confirmation_issue_report": gapp_issues,
            "notification_failure_report": notif_issues,
        },
    }


@app.get("/logs")
def logs(limit: int = 200, x_ai_plugin_secret: str = Header(default=None)) -> dict[str, Any]:  # type: ignore[assignment]
    _require_secret(x_ai_plugin_secret)
    lim = max(1, min(500, int(limit)))
    rows = db.query_all(
        """
        SELECT id, user_id, username, role, command, tool_name, tool_args_json, status, error_message, created_at
        FROM ai_action_logs
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
        """,
        (lim,),
    )
    return {"ok": True, "rows": rows, "count": len(rows)}
