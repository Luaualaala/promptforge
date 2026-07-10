"""
Prompt Forge — LLM backends, called from ComfyUI's own Python process.

Moving these calls out of the browser (where the standalone HTML made them)
removes every CORS problem the old architecture had and keeps the Anthropic
API key on disk server-side instead of in browser localStorage.

Standard library only (urllib) — no extra dependencies. Behavior mirrors the
original prompt-forge.html:

  local / openai  -> POST {base}/v1/chat/completions   (LM Studio, llama.cpp, vLLM…)
  local / ollama  -> POST {base}/api/chat
  anthropic       -> POST https://api.anthropic.com/v1/messages
"""
import json
import urllib.error
import urllib.parse
import urllib.request

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


class LLMError(Exception):
    """Readable error for the UI; never crashes ComfyUI."""


def _validate_local_base(raw):
    try:
        parsed = urllib.parse.urlparse(str(raw or "").strip())
    except ValueError:
        parsed = None
    if not parsed or parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise LLMError(
            "Local base URL is not valid — need e.g. http://127.0.0.1:11434")
    return f"{parsed.scheme}://{parsed.netloc}"


def _post_json(url, payload, headers, timeout):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except OSError:
            pass
        raise LLMError(f"HTTP {e.code} from {url}"
                       + (f" — {detail}" if detail else ""))
    except urllib.error.URLError as e:
        raise LLMError(f"Could not reach {url} — {e.reason}. "
                       "Is the server running?")
    except TimeoutError:
        raise LLMError(f"Request to {url} timed out.")
    except ValueError as e:
        raise LLMError(f"Response from {url} was not valid JSON: {e}")


def call_llm(config, system, user):
    """Send one system+user chat exchange, return the assistant text."""
    timeout = config.get("timeout_seconds", 120)
    try:
        timeout = max(5, min(600, float(timeout)))
    except (TypeError, ValueError):
        timeout = 120

    provider = config.get("provider", "local")
    if provider == "anthropic":
        key = (config.get("anthropic_key") or "").strip()
        if not key:
            raise LLMError("No Anthropic API key configured — set one in the "
                           "Prompt Forge panel (it is stored locally only).")
        model = (config.get("anthropic_model") or "").strip() or "claude-sonnet-5"
        # 1024 gives the full-draft JSON schema (17 fields) enough room to
        # finish without truncating mid-string, which otherwise produces
        # invalid JSON the panel can't parse.
        data = _post_json(
            ANTHROPIC_URL,
            {"model": model, "max_tokens": 1024, "system": system,
             "messages": [{"role": "user", "content": user}]},
            {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION},
            timeout,
        )
        return "\n".join(b.get("text", "") for b in data.get("content", []))

    base = _validate_local_base(config.get("local_url"))
    model = (config.get("local_model") or "").strip()
    fmt = config.get("local_format", "openai")
    path = "/api/chat" if fmt == "ollama" else "/v1/chat/completions"
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    data = _post_json(base + path, payload, {}, timeout)
    if fmt == "ollama":
        msg = data.get("message") or {}
        return msg.get("content") or json.dumps(data)
    choices = data.get("choices") or []
    if choices and isinstance(choices[0], dict):
        return (choices[0].get("message") or {}).get("content") or json.dumps(data)
    return json.dumps(data)
