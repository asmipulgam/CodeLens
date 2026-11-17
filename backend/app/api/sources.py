"""What employees can see about data sources: the list (with their access) and each source's catalog."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentPrincipal
from app.db import get_db
from app.errors import forbidden, not_found
from app.models import Source

router = APIRouter(prefix="/api/sources", tags=["sources"])
Db = Annotated[AsyncSession, Depends(get_db)]


def _summary(source: Source, access: str) -> dict[str, Any]:
    return {
        "id": source.id,
        "name": source.name,
        "type": source.type,
        "description": source.description,
        "status": source.status,
        "access": access,
        "exampleQuestions": source.example_questions if access == "granted" else [],
    }


@router.get("")
async def list_sources(principal: CurrentPrincipal, db: Db) -> list[dict[str, Any]]:
    """Every enabled source is listed so people can request access; details need access."""
    allowed = principal.allowed_source_ids
    sources = await db.scalars(select(Source).where(Source.enabled.is_(True)).order_by(Source.name))
    return [_summary(s, "granted" if s.id in allowed else "none") for s in sources]


@router.get("/{source_id}/catalog")
async def catalog(source_id: str, principal: CurrentPrincipal, db: Db) -> dict[str, Any]:
    source = await db.get(Source, source_id)
    if source is None or not source.enabled:
        raise not_found("Data source not found.")
    if source.id not in principal.allowed_source_ids:
        raise forbidden("You don't have access to this data source.")
    names = [entity["name"] for entity in source.exposed]
    return {
        "source": _summary(source, "granted"),
        "entities": [
            {
                # Qualify with the schema only when two exposed tables share a name.
                "name": e["name"] if names.count(e["name"]) == 1 else f"{e['namespace']}.{e['name']}",
                "kind": e["kind"],
                "description": e["description"],
                "fields": e["fields"],
            }
            for e in source.exposed
        ],
        "glossary": source.glossary,
    }
