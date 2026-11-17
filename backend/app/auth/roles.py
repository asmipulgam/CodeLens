"""Roles, permissions, and syncing identity-provider groups to roles."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Role, User, UserRole


class Permissions(BaseModel):
    canViewQuery: bool = False
    canExport: bool = False
    canChooseSource: bool = False
    canAdmin: bool = False
    canAudit: bool = False
    exportRowLimit: int = 0


BUILT_IN_ROLES: list[dict[str, Any]] = [
    {
        "id": "business",
        "name": "Business user",
        "description": "Sales, support and account teams who answer client questions",
        "permissions": Permissions(),
    },
    {
        "id": "analyst",
        "name": "Analyst",
        "description": "Can see generated queries, choose sources and export",
        "permissions": Permissions(
            canViewQuery=True, canExport=True, canChooseSource=True, exportRowLimit=10_000
        ),
    },
    {
        "id": "admin",
        "name": "Admin",
        "description": "Manages data sources, roles and the cache",
        "permissions": Permissions(
            canViewQuery=True,
            canExport=True,
            canChooseSource=True,
            canAdmin=True,
            canAudit=True,
            exportRowLimit=50_000,
        ),
    },
    {
        "id": "auditor",
        "name": "Auditor",
        "description": "Security and compliance reviewers (read-only)",
        "permissions": Permissions(canViewQuery=True, canAudit=True),
    },
]


async def ensure_built_in_roles(db: AsyncSession) -> None:
    """Insert any missing built-in role. Existing rows are left alone so admins can tune them."""
    existing = set(await db.scalars(select(Role.id)))
    for spec in BUILT_IN_ROLES:
        if spec["id"] not in existing:
            db.add(
                Role(
                    id=spec["id"],
                    name=spec["name"],
                    description=spec["description"],
                    permissions=spec["permissions"].model_dump(),
                    source_ids=[],
                    built_in=True,
                )
            )


def combine_permissions(roles: list[Role]) -> Permissions:
    """A user gets a permission if any of their roles has it, and the highest export limit."""
    combined = Permissions()
    for role in roles:
        perms = Permissions.model_validate(role.permissions)
        for name in ("canViewQuery", "canExport", "canChooseSource", "canAdmin", "canAudit"):
            if getattr(perms, name):
                setattr(combined, name, True)
        combined.exportRowLimit = max(combined.exportRowLimit, perms.exportRowLimit)
    if not combined.canExport:
        combined.exportRowLimit = 0
    return combined


def roles_of(user: User) -> list[Role]:
    seen: dict[str, Role] = {}
    for link in user.role_links:
        seen.setdefault(link.role_id, link.role)
    return sorted(seen.values(), key=lambda role: role.id)


def roles_from_groups(
    groups: list[str], group_role_map: dict[str, list[str]], default_roles: list[str]
) -> set[str]:
    role_ids = set(default_roles)
    for group in groups:
        role_ids.update(group_role_map.get(group, []))
    return role_ids


async def sync_group_roles(db: AsyncSession, user: User, role_ids: set[str]) -> None:
    """Replace the user's group-derived roles. Unknown role ids in the mapping are ignored."""
    known = set(await db.scalars(select(Role.id).where(Role.id.in_(role_ids)))) if role_ids else set()
    user.role_links = [link for link in user.role_links if link.origin != "group"]
    await db.flush()
    for role_id in sorted(known):
        user.role_links.append(UserRole(user_id=user.id, role_id=role_id, origin="group"))
    await db.flush()
    # Make the relationship's role objects available without another lazy load.
    await db.refresh(user, attribute_names=["role_links"])
