"""Admin: roles. Listing is needed by the data-source wizard (choosing who may use a source).
Creating and editing roles arrives with the rest of user management in phase 5."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import Principal, require_permission
from app.auth.roles import Permissions
from app.db import get_db
from app.models import Role, UserRole

router = APIRouter(prefix="/api/admin/roles", tags=["admin: roles"])


@router.get("")
async def list_roles(
    _: Annotated[Principal, Depends(require_permission("canAdmin"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[dict[str, Any]]:
    counts = dict(
        (
            await db.execute(
                select(UserRole.role_id, func.count(func.distinct(UserRole.user_id))).group_by(
                    UserRole.role_id
                )
            )
        ).all()
    )
    roles = await db.scalars(select(Role).order_by(Role.built_in.desc(), Role.name))
    return [
        {
            "id": role.id,
            "name": role.name,
            "description": role.description,
            "permissions": Permissions.model_validate(role.permissions).model_dump(),
            "sourceIds": role.source_ids,
            "memberCount": counts.get(role.id, 0),
            "builtIn": role.built_in,
        }
        for role in roles
    ]
