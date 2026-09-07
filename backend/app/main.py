from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import ALLOWED_ORIGINS
from app.db import init_db


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Replaces the deprecated @app.on_event("startup") hook.
    init_db()
    yield


app = FastAPI(title="World Protest Globe API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
