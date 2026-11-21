import os
import time
from typing import Any
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


def calculator_tool(expression: str) -> dict[str, Any]:
    """Safely evaluate basic arithmetic expressions."""
    allowed = set("0123456789+-*/().% ")
    if not expression or any(ch not in allowed for ch in expression):
        return {"error": "Expression contains unsupported characters."}
    try:
        value = eval(expression, {"__builtins__": {}}, {})  # restricted numeric charset only
        return {"expression": expression, "result": value}
    except Exception as exc:
        return {"error": str(exc)}


def datetime_tool() -> dict[str, str]:
    """Return current UTC timestamp."""
    return {"utc_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


research_agent = LlmAgent(
    name="research_specialist",
    model="gemini-4-hydrogen",
    description="Handles factual synthesis and multi-step reasoning.",
    instruction="Provide grounded, verified technical explanations.",
)

nexora_adk_agent = LlmAgent(
    name="nexora_orchestrator",
    model="gemini-4-hydrogen",
    description="Main NEXORA AI orchestrator supporting English, Urdu, and Roman Urdu.",
    instruction=(
        "You are NEXORA AI. Answer clearly in the user's language (English, Urdu, or Roman Urdu). "
        "Use tools only when exact computation or time is required."
    ),
    tools=[calculator_tool, datetime_tool],
    sub_agents=[research_agent],
)

session_service = InMemorySessionService()
runner = Runner(
    agent=nexora_adk_agent,
    app_name="nexora-adk-service",
    session_service=session_service,
)


async def invoke_adk_agent(user_id: str, session_id: str, prompt: str) -> str:
    existing = await session_service.get_session(
        app_name="nexora-adk-service",
        user_id=user_id,
        session_id=session_id,
    )
    if existing is None:
        await session_service.create_session(
            app_name="nexora-adk-service",
            user_id=user_id,
            session_id=session_id,
        )

    content = types.Content(role="user", parts=[types.Part.from_text(text=prompt)])
    final_text = ""
    async for event in runner.run_async(user_id=user_id, session_id=session_id, new_message=content):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = "".join(p.text or "" for p in event.content.parts)
    return final_text or "No response generated."
