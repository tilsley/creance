"""
Wire-compat scrub — the gateway owns wire formats (ADR-0024/0025), and that includes
absorbing client/upstream API-version skew. Newer Anthropic-wire clients (OpenCode ≥1.16
via @ai-sdk/anthropic) send tool fields from API betas that Bedrock's Anthropic endpoint
rejects with 400 "Extra inputs are not permitted" — which agent UIs then surface as a
silent stop ("the request hangs"). Strip what the upstream can't take, in ONE place, so
every caller works regardless of client SDK vintage.

Register in config.yaml:  litellm_settings: { callbacks: [..., compat_hook.proxy_handler_instance] }
"""
from litellm.integrations.custom_logger import CustomLogger

# Tool-definition fields from Anthropic API betas that Bedrock rejects. Dropping them is
# behavior-neutral: they only tune streaming delivery (e.g. eager_input_streaming streams
# tool args before they're complete), never the result.
_UNSUPPORTED_TOOL_FIELDS = ("eager_input_streaming",)


def _scrub_tools(tools: list) -> None:
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        for field in _UNSUPPORTED_TOOL_FIELDS:
            tool.pop(field, None)
            # the anthropic wire nests custom-tool attrs under "custom"
            if isinstance(tool.get("custom"), dict):
                tool["custom"].pop(field, None)


class WireCompat(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type):
        if isinstance(data.get("tools"), list):
            _scrub_tools(data["tools"])
        return data


proxy_handler_instance = WireCompat()
