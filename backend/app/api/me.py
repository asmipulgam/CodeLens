from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentPrincipal
from app.db import get_db
from app.models import Preference

router = APIRouter(prefix="/api/me", tags=["me"])


class PreferencesBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    showGeneratedQuery: bool
    defaultSourceIds: list[Annotated[str, Field(max_length=64)]] = Field(max_length=50)


@router.get("/preferences", response_model=PreferencesBody)
async def get_preferences(
    principal: CurrentPrincipal, db: Annotated[AsyncSession, Depends(get_db)]
) -> PreferencesBody:
    prefs = await db.get(Preference, principal.user.id)
    if prefs is None:
        return PreferencesBody(showGeneratedQuery=False, defaultSourceIds=[])
    return _visible(prefs.show_generated_query, prefs.default_source_ids, principal)


@router.put("/preferences", response_model=PreferencesBody)
async def put_preferences(
    body: PreferencesBody, principal: CurrentPrincipal, db: Annotated[AsyncSession, Depends(get_db)]
) -> PreferencesBody:
    clean = _visible(body.showGeneratedQuery, body.defaultSourceIds, principal)
    prefs = await db.get(Preference, principal.user.id)
    if prefs is None:
        prefs = Preference(user_id=principal.user.id)
        db.add(prefs)
    prefs.show_generated_query = clean.showGeneratedQuery
    prefs.default_source_ids = clean.defaultSourceIds
    return clean


def _visible(show_query: bool, source_ids: list[str], principal: CurrentPrincipal) -> PreferencesBody:
    """Drop anything the user isn't allowed: queries without canViewQuery, sources without access.
    Re-applied on read too, so losing a role takes effect immediately."""
    allowed = principal.allowed_source_ids
    return PreferencesBody(
        showGeneratedQuery=show_query and principal.permissions.canViewQuery,
        defaultSourceIds=list(dict.fromkeys(sid for sid in source_ids if sid in allowed)),
    )
