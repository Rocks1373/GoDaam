import json
from dataclasses import dataclass
from typing import Any, Optional, Dict

import requests

from .config import Settings
from .prompts import SYSTEM_PROMPT, TOOL_LIST_PROMPT, USER_PROMPT_TEMPLATE


class AgentError(Exception):
    pass


@dataclass(frozen=True)
class ToolDecision:
    tool_name: str
    tool_args: Dict[str, Any]
    needs_confirmation: bool
    confirmation_reason: Optional[str]
    summary: str


def _compact_context(context: Optional[Dict[str, Any]], max_chars: int = 6_500) -> str:
    if not context:
        return "No extra application context was provided."
    safe = {
        "pageContext": context.get("pageContext"),
        "entityId": context.get("entityId"),
        "userRole": context.get("userRole"),
        "knowledge": context.get("knowledge"),
    }
    text = json.dumps(safe, ensure_ascii=False, indent=2, default=str)
    return text[:max_chars]


def _provider_headers(provider: str, api_key: str) -> Dict[str, str]:
    if provider == "openai":
        return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if provider == "anthropic":
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
    if provider == "gemini":
        return {"Content-Type": "application/json", "x-goog-api-key": api_key}
    raise AgentError(f"Unsupported provider: {provider}")


def _call_openai(settings: Settings, command: str, context: Optional[Dict[str, Any]] = None) -> str:
    if not settings.openai_api_key:
        raise AgentError("OPENAI_API_KEY is not set")
    url = "https://api.openai.com/v1/chat/completions"
    payload = {
        "model": settings.ai_model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT},
            {"role": "user", "content": USER_PROMPT_TEMPLATE.format(command=command, context=_compact_context(context))},
        ],
        "response_format": {"type": "json_object"},
    }
    r = requests.post(url, headers=_provider_headers("openai", settings.openai_api_key), json=payload, timeout=45)
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"]


def _call_anthropic(settings: Settings, command: str, context: Optional[Dict[str, Any]] = None) -> str:
    if not settings.anthropic_api_key:
        raise AgentError("ANTHROPIC_API_KEY is not set")
    url = "https://api.anthropic.com/v1/messages"
    payload = {
        "model": settings.ai_model,
        "max_tokens": 800,
        "temperature": 0,
        "system": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT,
        "messages": [{"role": "user", "content": USER_PROMPT_TEMPLATE.format(command=command, context=_compact_context(context))}],
    }
    r = requests.post(url, headers=_provider_headers("anthropic", settings.anthropic_api_key), json=payload, timeout=45)
    r.raise_for_status()
    data = r.json()
    # Anthropic returns list of content blocks; we expect first text block to be JSON.
    blocks = data.get("content") or []
    text = ""
    for b in blocks:
        if b.get("type") == "text":
            text += b.get("text") or ""
    return text.strip()


def _call_gemini(settings: Settings, command: str, context: Optional[Dict[str, Any]] = None) -> str:
    if not settings.gemini_api_key:
        raise AgentError("GEMINI_API_KEY is not set")
    # Gemini REST: generateContent
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.ai_model}:generateContent"
    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT + "\n\n" + USER_PROMPT_TEMPLATE.format(command=command, context=_compact_context(context))}]}
        ],
        "generationConfig": {"temperature": 0},
    }
    r = requests.post(url, headers=_provider_headers("gemini", settings.gemini_api_key), json=payload, timeout=45)
    try:
        r.raise_for_status()
    except requests.HTTPError as e:
        message = str(e)
        try:
            err = r.json().get("error") or {}
            message = err.get("message") or err.get("status") or message
        except Exception:
            pass
        raise AgentError(f"Gemini API request failed: {message[:500]}") from e
    data = r.json()
    text = (
        (((data.get("candidates") or [])[0]).get("content") or {}).get("parts") or [{}]
    )[0].get("text") or ""
    return text.strip()


def _call_ollama(settings: Settings, command: str, context: Optional[Dict[str, Any]] = None) -> str:
    url = f"{settings.ollama_base_url}/api/chat"
    payload = {
        "model": settings.ai_model,
        "stream": False,
        "options": {
            "temperature": 0,
            "repeat_penalty": 1.18,
            "num_ctx": 8192,
            "num_predict": 400,
        },
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT},
            {"role": "user", "content": USER_PROMPT_TEMPLATE.format(command=command, context=_compact_context(context))},
        ],
        "format": "json",
    }
    try:
        r = requests.post(url, json=payload, timeout=90)
        r.raise_for_status()
    except requests.RequestException as e:
        raise AgentError(f"Ollama request failed: {str(e)[:500]}") from e
    data = r.json()
    return str((data.get("message") or {}).get("content") or "").strip()


def _parse_model_json(raw: str) -> Dict[str, Any]:
    text = str(raw or "").strip()
    if text.startswith("<think>"):
        end = text.find("</think>")
        if end >= 0:
            text = text[end + len("</think>") :].strip()
    try:
        return json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def decide_tool(settings: Settings, command: str, context: Optional[Dict[str, Any]] = None) -> ToolDecision:
    provider = settings.ai_provider
    if provider == "openai":
        raw = _call_openai(settings, command, context)
    elif provider == "anthropic":
        raw = _call_anthropic(settings, command, context)
    elif provider == "gemini":
        raw = _call_gemini(settings, command, context)
    elif provider == "ollama":
        raw = _call_ollama(settings, command, context)
    else:
        raise AgentError(f"Unknown AI_PROVIDER: {provider}")

    try:
        obj = _parse_model_json(raw)
    except Exception as e:
        raise AgentError(f"Model did not return valid JSON. Raw: {raw[:500]}") from e

    tool_name = str(obj.get("tool_name") or "").strip()
    tool_args = obj.get("tool_args") or {}
    needs_confirmation = bool(obj.get("needs_confirmation"))
    confirmation_reason = obj.get("confirmation_reason")
    summary = str(obj.get("summary") or "").strip() or f"Run tool {tool_name}"

    if not tool_name:
        raise AgentError("Model response missing tool_name")
    if not isinstance(tool_args, dict):
        raise AgentError("tool_args must be an object")

    return ToolDecision(
        tool_name=tool_name,
        tool_args=tool_args,
        needs_confirmation=needs_confirmation,
        confirmation_reason=str(confirmation_reason) if confirmation_reason else None,
        summary=summary,
    )
