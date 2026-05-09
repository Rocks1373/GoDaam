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
        return {"Content-Type": "application/json"}
    raise AgentError(f"Unsupported provider: {provider}")


def _call_openai(settings: Settings, command: str) -> str:
    if not settings.openai_api_key:
        raise AgentError("OPENAI_API_KEY is not set")
    url = "https://api.openai.com/v1/chat/completions"
    payload = {
        "model": settings.ai_model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT},
            {"role": "user", "content": USER_PROMPT_TEMPLATE.format(command=command)},
        ],
        "response_format": {"type": "json_object"},
    }
    r = requests.post(url, headers=_provider_headers("openai", settings.openai_api_key), json=payload, timeout=45)
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"]


def _call_anthropic(settings: Settings, command: str) -> str:
    if not settings.anthropic_api_key:
        raise AgentError("ANTHROPIC_API_KEY is not set")
    url = "https://api.anthropic.com/v1/messages"
    payload = {
        "model": settings.ai_model,
        "max_tokens": 800,
        "temperature": 0,
        "system": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT,
        "messages": [{"role": "user", "content": USER_PROMPT_TEMPLATE.format(command=command)}],
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


def _call_gemini(settings: Settings, command: str) -> str:
    if not settings.gemini_api_key:
        raise AgentError("GEMINI_API_KEY is not set")
    # Gemini REST: generateContent
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.ai_model}:generateContent?key={settings.gemini_api_key}"
    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT + "\n\n" + TOOL_LIST_PROMPT + "\n\n" + USER_PROMPT_TEMPLATE.format(command=command)}]}
        ],
        "generationConfig": {"temperature": 0},
    }
    r = requests.post(url, headers=_provider_headers("gemini", "x"), json=payload, timeout=45)
    r.raise_for_status()
    data = r.json()
    text = (
        (((data.get("candidates") or [])[0]).get("content") or {}).get("parts") or [{}]
    )[0].get("text") or ""
    return text.strip()


def decide_tool(settings: Settings, command: str) -> ToolDecision:
    provider = settings.ai_provider
    if provider == "openai":
        raw = _call_openai(settings, command)
    elif provider == "anthropic":
        raw = _call_anthropic(settings, command)
    elif provider == "gemini":
        raw = _call_gemini(settings, command)
    else:
        raise AgentError(f"Unknown AI_PROVIDER: {provider}")

    try:
        obj = json.loads(raw)
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

