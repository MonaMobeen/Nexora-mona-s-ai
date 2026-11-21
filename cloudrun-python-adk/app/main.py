import os
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
from app.adk_orchestrator import invoke_adk_agent

app = FastAPI(title="NEXORA AI — Python ADK & FastAPI Service", version="1.0.0")


class ChatRequest(BaseModel):
    user_id: str = Field(default="default_user", max_length=128)
    session_id: str = Field(default="default_session", max_length=128)
    message: str = Field(min_length=1, max_length=8000)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "nexora-python-adk"}


@app.get("/.well-known/agent.json")
async def agent_card() -> dict[str, object]:
    return {
        "id": "nexora-python-adk",
        "name": "NEXORA AI Python ADK Agent",
        "version": "1.0.0",
        "capabilities": {"streaming": True, "a2a": True, "mcp": True},
    }


@app.post("/api/adk/chat")
async def adk_chat(req: ChatRequest) -> dict[str, str]:
    if not os.environ.get("GEMINI_API_KEY"):
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY secret is not configured.")
    reply = await invoke_adk_agent(req.user_id, req.session_id, req.message)
    return {"reply": reply, "agent": "nexora_orchestrator"}


@app.websocket("/ws/live")
async def live_audio_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        await websocket.send_json({"type": "error", "message": "GEMINI_API_KEY not configured."})
        await websocket.close()
        return

    client = genai.Client(api_key=api_key)
    try:
        async with client.aio.live.connect(
            model="gemini-3.8-live",
            config=types.LiveConnectConfig(response_modalities=[types.Modality.AUDIO]),
        ) as session:
            while True:
                payload = await websocket.receive_json()
                if payload.get("type") == "audio":
                    await session.send_realtime_input(
                        audio=types.Blob(data=payload["data"], mime_type="audio/pcm;rate=16000")
                    )
    except WebSocketDisconnect:
        pass
