"""HuggingFace `safetensors` klasörünü OpenAI uyumlu uç olarak sunar.

Thalamus bu betiği `%TEMP%/thalamus_models/hf_server.py` olarak yazar ve
`python -u hf_server.py --model <klasör> --name <ad> --port <p>` ile başlatır.
Amaç: indirilmiş yerel modelleri (vLLM kurmadan) sohbette kullanılabilir
kılmak. `transformers` + `torch` + `fastapi/uvicorn` gerekir.
"""

import argparse
import json
import threading
import time

import torch
import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

app = FastAPI()
STATE = {}


def _chunk(content, model_id, finish=None):
    return (
        "data: "
        + json.dumps(
            {
                "id": "chatcmpl-local",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model_id,
                "choices": [
                    {"index": 0, "delta": ({} if finish else {"content": content}), "finish_reason": finish}
                ],
            },
            ensure_ascii=False,
        )
        + "\n\n"
    )


@app.get("/health")
def health():
    return {"ok": True, "model": STATE.get("model_id")}


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [
            {
                "id": STATE.get("model_id", "local-model"),
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: dict):
    model_id = STATE.get("model_id", "local-model")
    tok = STATE["tok"]
    mdl = STATE["model"]
    messages = req.get("messages") or []
    stream = bool(req.get("stream"))
    max_new = int(req.get("max_tokens") or 512)
    temperature = float(req.get("temperature") or 0.7)

    # Sohbet şablonu yoksa düz "rol: içerik" birleştirmesine düş.
    try:
        text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        text = "\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages) + "\nassistant:"

    inputs = tok([text], return_tensors="pt").to(mdl.device)
    prompt_tokens = int(inputs["input_ids"].shape[1])
    gen_kwargs = {
        "max_new_tokens": max_new,
        "do_sample": temperature > 0,
        "temperature": max(temperature, 1e-5),
        "pad_token_id": tok.eos_token_id or tok.pad_token_id,
    }

    if not stream:
        with torch.no_grad():
            out = mdl.generate(**inputs, **gen_kwargs)
        new_tokens = out[0][prompt_tokens:]
        content = tok.decode(new_tokens, skip_special_tokens=True)
        n = int(new_tokens.shape[0])
        return {
            "id": "chatcmpl-local",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_id,
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": n,
                "total_tokens": prompt_tokens + n,
            },
        }

    streamer = TextIteratorStreamer(tok, skip_prompt=True, skip_special_tokens=True)
    kwargs = dict(inputs)
    kwargs.update(gen_kwargs)
    kwargs["streamer"] = streamer
    worker = threading.Thread(target=mdl.generate, kwargs=kwargs)
    worker.start()

    def events():
        try:
            for piece in streamer:
                if piece:
                    yield _chunk(piece, model_id)
        finally:
            worker.join(timeout=1)
        yield _chunk("", model_id, finish="stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--name", default=None)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--dtype", default="auto")
    args = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=args.dtype,
        device_map="auto",
    )
    model.eval()
    STATE["tok"] = tok
    STATE["model"] = model
    STATE["model_id"] = args.name or args.model
    print(f"ready: {STATE['model_id']} on {next(model.parameters()).device}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
