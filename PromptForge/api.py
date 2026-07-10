"""
Prompt Forge — backend HTTP routes, mounted on ComfyUI's own aiohttp server.

No separate server, no separate port, no CORS: the panel JS calls these
same-origin. Registered from __init__.py only when ComfyUI's PromptServer is
importable (so tests can import the package without ComfyUI).

Routes (all under /promptforge/):
  GET  /promptforge/config      -> LLM settings (API key never included)
  POST /promptforge/config      -> merge + save LLM settings
  POST /promptforge/llm         -> {system, user} -> {text} | {error}
  GET  /promptforge/templates   -> cross-workflow template library
  POST /promptforge/templates   -> replace template library
"""
import asyncio
import json

from . import llm_client, storage


def register_routes():
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    def _json_error(message, status=400):
        return web.json_response({"error": str(message)}, status=status)

    @routes.get("/promptforge/config")
    async def get_config(request):
        return web.json_response(storage.public_llm_config())

    @routes.post("/promptforge/config")
    async def set_config(request):
        try:
            data = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error("invalid JSON body")
        if not isinstance(data, dict):
            return _json_error("config body must be a JSON object")
        cfg = storage.save_llm_config(data)
        return web.json_response(storage.public_llm_config(cfg))

    @routes.post("/promptforge/llm")
    async def run_llm(request):
        try:
            data = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error("invalid JSON body")
        system = str(data.get("system") or "")
        user = str(data.get("user") or "")
        if not user.strip():
            return _json_error("empty user prompt")
        cfg = storage.load_llm_config()
        loop = asyncio.get_event_loop()
        try:
            # urllib is blocking — run it off the event loop so a slow local
            # model never stalls the ComfyUI server.
            text = await loop.run_in_executor(
                None, llm_client.call_llm, cfg, system, user)
        except llm_client.LLMError as e:
            return _json_error(e, status=502)
        except Exception as e:  # keep ComfyUI alive whatever happens
            print(f"[PromptForge] unexpected LLM error: {e!r}")
            return _json_error(f"unexpected error: {e}", status=500)
        return web.json_response({"text": text})

    @routes.get("/promptforge/templates")
    async def get_templates(request):
        return web.json_response(storage.load_templates())

    @routes.post("/promptforge/templates")
    async def set_templates(request):
        try:
            data = await request.json()
        except (ValueError, json.JSONDecodeError):
            return _json_error("invalid JSON body")
        try:
            storage.save_templates(data)
        except (ValueError, OSError) as e:
            return _json_error(e)
        return web.json_response({"ok": True, "count": len(data)})

    print("[PromptForge] backend routes registered under /promptforge/")
