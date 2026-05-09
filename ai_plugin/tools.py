import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Set

from .api_client import BackendClient
from .db import Db


class ToolError(Exception):
    pass


@dataclass(frozen=True)
class ToolContext:
    db: Db
    backend: BackendClient
    auto_fix: bool


def _norm(s: Any) -> str:
    return str(s or "").strip()


def _lower(s: Any) -> str:
    return _norm(s).lower()


def get_orders(ctx: ToolContext, status: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
    limit = max(1, min(1000, int(limit)))
    status_l = _lower(status)
    rows = ctx.db.query_all(
        """
        SELECT id, outbound_number, delivery, sales_doc, customer_reference, sold_to, name_1, status, created_at, updated_at, invoice_number
        FROM outbound_orders
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    )
    if status_l:
        rows = [r for r in rows if _lower(r.get("status")) == status_l]
    return {"orders": rows, "count": len(rows)}


def get_order_by_id(ctx: ToolContext, order_id: int) -> Dict[str, Any]:
    oid = int(order_id)
    order = ctx.db.query_one("SELECT * FROM outbound_orders WHERE id = ?", (oid,))
    if not order:
        raise ToolError("Order not found")
    items = ctx.db.query_all("SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id ASC", (oid,))
    dn = ctx.db.query_one(
        "SELECT * FROM delivery_notes WHERE outbound_number = ? OR outbound_number = ? LIMIT 1",
        (_norm(order.get("outbound_number")), _norm(order.get("delivery"))),
    )
    return {"order": order, "items": items, "delivery_note": dn}


def _gapp_rules_from_dn(dn: Dict[str, Any]) -> List[str]:
    issues: List[str] = []
    trans = _upper_trans(dn.get("transportation_type"))
    if trans != "GAPP":
        return issues
    # Confirm-to-delivery must be valid: confirmed_at + driver_task_id must exist
    if not _norm(dn.get("confirmed_at")) or not dn.get("driver_task_id"):
        issues.append("GAPP: Confirm for delivery not completed (missing confirmed_at or driver_task_id).")
    # Assigned driver must exist
    if not (_norm(dn.get("driver_name")) or dn.get("driver_id")):
        issues.append("GAPP: Assigned driver missing (driver_name/driver_id).")
    if not _norm(dn.get("driver_mobile")):
        issues.append("GAPP: Driver phone missing (driver_mobile).")
    if not _norm(dn.get("vehicle")):
        issues.append("GAPP: Vehicle missing.")
    # Mobile notification should be sent (best-effort heuristic via notification_log)
    if dn.get("driver_task_id") and dn.get("driver_mobile"):
        pass
    return issues


def _upper_trans(v: Any) -> str:
    s = _norm(v)
    return s.upper() if s else ""


def _find_dn_for_order(ctx: ToolContext, order: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ob = _norm(order.get("outbound_number"))
    dl = _norm(order.get("delivery"))
    if not ob and not dl:
        return None
    return ctx.db.query_one(
        "SELECT * FROM delivery_notes WHERE outbound_number = ? OR outbound_number = ? LIMIT 1",
        (ob, dl),
    )


def check_order_match(ctx: ToolContext, order_id: int) -> Dict[str, Any]:
    payload = get_order_by_id(ctx, order_id)
    order = payload["order"]
    items = payload["items"] or []
    dn = payload["delivery_note"]

    issues: List[str] = []
    if not items:
        issues.append("Outbound order has no items.")
    if not dn:
        issues.append("Missing delivery note for this outbound (no delivery_notes row).")
    else:
        if _lower(dn.get("status")) == "delivered" and _lower(order.get("status")) != "delivered":
            issues.append("DN is Delivered but outbound_order.status is not Delivered.")
        if _lower(order.get("status")) == "delivered" and _lower(dn.get("status")) != "delivered":
            issues.append("Outbound is Delivered but DN status is not Delivered.")
        # Basic header consistency checks
        if _norm(dn.get("outbound_number")) and _norm(order.get("outbound_number")) and _norm(dn.get("outbound_number")) != _norm(order.get("outbound_number")):
            issues.append("DN outbound_number does not match outbound_orders.outbound_number.")

    return {
        "order_id": int(order_id),
        "outbound_number": order.get("outbound_number") or order.get("delivery"),
        "matched": len(issues) == 0,
        "issues": issues,
    }


def check_delivery_type_rules(ctx: ToolContext, order_id: int) -> Dict[str, Any]:
    payload = get_order_by_id(ctx, order_id)
    order = payload["order"]
    dn = payload["delivery_note"]
    if not dn:
        return {"order_id": int(order_id), "ok": False, "issues": ["Missing delivery note."]}

    issues = _gapp_rules_from_dn(dn)
    return {
        "order_id": int(order_id),
        "outbound_number": order.get("outbound_number") or order.get("delivery"),
        "transportation_type": dn.get("transportation_type"),
        "ok": len(issues) == 0,
        "issues": issues,
    }


def check_driver_assignment(ctx: ToolContext, order_id: int) -> Dict[str, Any]:
    payload = get_order_by_id(ctx, order_id)
    dn = payload["delivery_note"]
    if not dn:
        return {"order_id": int(order_id), "ok": False, "issues": ["Missing delivery note."]}
    trans = _upper_trans(dn.get("transportation_type"))
    issues: List[str] = []
    if trans == "GAPP":
        if not (_norm(dn.get("driver_name")) or dn.get("driver_id")):
            issues.append("GAPP driver is missing.")
        if not _norm(dn.get("driver_mobile")):
            issues.append("GAPP driver mobile is missing.")
    return {"order_id": int(order_id), "transportation_type": dn.get("transportation_type"), "ok": len(issues) == 0, "issues": issues}


def send_driver_notification(ctx: ToolContext, order_id: int) -> Dict[str, Any]:
    """
    Dangerous: should only run after explicit confirmation.
    Current implementation delegates to existing backend confirm flow if possible,
    but this project sends notifications on DN confirm; so this tool only reports.
    """
    payload = get_order_by_id(ctx, order_id)
    dn = payload["delivery_note"]
    if not dn:
        raise ToolError("Missing delivery note")
    return {
        "ok": False,
        "dangerous": True,
        "message": "Notification sending is controlled by backend delivery confirmation. Use backend /api/delivery-notes/:id/confirm or re-confirm in UI.",
        "dn_id": dn.get("id"),
    }


def update_delivery_status(ctx: ToolContext, order_id: int, new_status: str) -> Dict[str, Any]:
    """
    Dangerous: should only run after explicit confirmation token.
    Implementation: delegate to backend routes when possible; otherwise no-op.
    """
    payload = get_order_by_id(ctx, order_id)
    dn = payload["delivery_note"]
    if not dn:
        raise ToolError("Missing delivery note")
    return {
        "ok": False,
        "dangerous": True,
        "message": "Delivery status updates must go through backend APIs (DN confirm/close/mark-delivered). This tool is gated and currently reports-only.",
        "dn_id": dn.get("id"),
        "requested_status": _norm(new_status),
    }


def generate_report(ctx: ToolContext, report_type: str, limit: int = 200) -> Dict[str, Any]:
    rt = _lower(report_type)
    limit = max(1, min(2000, int(limit)))

    if rt == "pending_delivery_report":
        rows = ctx.db.query_all(
            """
            SELECT id, outbound_number, customer_name, transportation_type, status, delivery_status, confirmed_at, is_closed, updated_at
            FROM delivery_notes
            WHERE lower(COALESCE(status,'draft')) != 'delivered'
            ORDER BY datetime(updated_at) DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return {"report_type": rt, "rows": rows, "count": len(rows)}

    if rt == "missing_driver_report":
        rows = ctx.db.query_all(
            """
            SELECT id, outbound_number, customer_name, transportation_type, driver_name, driver_mobile, vehicle, status, delivery_status, updated_at
            FROM delivery_notes
            WHERE upper(COALESCE(transportation_type,'')) = 'GAPP'
              AND (TRIM(COALESCE(driver_mobile,'')) = '' OR (TRIM(COALESCE(driver_name,'')) = '' AND driver_id IS NULL))
            ORDER BY datetime(updated_at) DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return {"report_type": rt, "rows": rows, "count": len(rows)}

    if rt == "gapp_confirmation_issue_report":
        rows = ctx.db.query_all(
            """
            SELECT id, outbound_number, customer_name, transportation_type, status, delivery_status,
                   confirmed_at, driver_task_id, is_closed, updated_at
            FROM delivery_notes
            WHERE upper(COALESCE(transportation_type,'')) = 'GAPP'
              AND (confirmed_at IS NULL OR driver_task_id IS NULL OR COALESCE(is_closed,0) = 0)
            ORDER BY datetime(updated_at) DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return {"report_type": rt, "rows": rows, "count": len(rows)}

    if rt == "notification_failure_report":
        # Best-effort heuristic: confirmed GAPP tasks but no notification_log entry for driver
        rows = ctx.db.query_all(
            """
            SELECT dn.id AS dn_id,
                   dn.outbound_number,
                   dn.customer_name,
                   dn.driver_name,
                   dn.driver_mobile,
                   t.driver_user_id,
                   dn.confirmed_at,
                   dn.updated_at
            FROM delivery_notes dn
            LEFT JOIN driver_delivery_tasks t ON t.id = dn.driver_task_id
            WHERE upper(COALESCE(dn.transportation_type,'')) = 'GAPP'
              AND dn.confirmed_at IS NOT NULL
              AND dn.driver_task_id IS NOT NULL
              AND t.driver_user_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM notification_log nl
                WHERE nl.user_id = t.driver_user_id
                  AND lower(COALESCE(nl.title,'')) LIKE '%confirmed%'
                  AND datetime(nl.created_at) >= datetime(dn.confirmed_at, '-10 minutes')
                  AND datetime(nl.created_at) <= datetime(dn.confirmed_at, '+60 minutes')
              )
            ORDER BY datetime(dn.updated_at) DESC, dn.id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return {"report_type": rt, "rows": rows, "count": len(rows)}

    if rt == "mismatch_report":
        # Outbounds that are Delivered but DN not Delivered, or DN Delivered but outbound not Delivered, plus missing DN.
        outbounds = ctx.db.query_all(
            """
            SELECT id, outbound_number, delivery, status, updated_at
            FROM outbound_orders
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows: List[Dict[str, Any]] = []
        for o in outbounds:
            dn = _find_dn_for_order(ctx, o)
            o_st = _lower(o.get("status"))
            dn_st = _lower(dn.get("status")) if dn else ""
            if dn is None:
                rows.append({"type": "missing_dn", "order": o})
                continue
            if dn_st == "delivered" and o_st != "delivered":
                rows.append({"type": "dn_delivered_but_order_not", "order": o, "dn": {"id": dn.get("id"), "status": dn.get("status")}})
            if o_st == "delivered" and dn_st != "delivered":
                rows.append({"type": "order_delivered_but_dn_not", "order": o, "dn": {"id": dn.get("id"), "status": dn.get("status")}})
        return {"report_type": rt, "rows": rows, "count": len(rows)}

    raise ToolError(f"Unknown report_type: {report_type}")


ToolFn = Callable[..., Dict[str, Any]]


TOOLS: Dict[str, ToolFn] = {
    "get_orders": get_orders,
    "get_order_by_id": get_order_by_id,
    "check_order_match": check_order_match,
    "check_delivery_type_rules": check_delivery_type_rules,
    "check_driver_assignment": check_driver_assignment,
    "send_driver_notification": send_driver_notification,
    "update_delivery_status": update_delivery_status,
    "generate_report": generate_report,
}


DANGEROUS_TOOLS: Set[str] = {"send_driver_notification", "update_delivery_status"}


def run_tool(ctx: ToolContext, tool_name: str, tool_args: Dict[str, Any]) -> Dict[str, Any]:
    name = _norm(tool_name)
    if name not in TOOLS:
        raise ToolError(f"Unknown tool: {name}")
    fn = TOOLS[name]
    try:
        return fn(ctx, **(tool_args or {}))
    except TypeError as e:
        raise ToolError(f"Invalid tool args for {name}: {e}") from e

