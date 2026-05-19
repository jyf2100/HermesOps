"""ORM models for Hermes Admin user management."""
from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    display_name = Column(String(100), default="")
    agent_id = Column(Integer, unique=True, nullable=True)
    is_active = Column(Boolean, default=False)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # WebUI provisioning
    webui_jwt = Column(Text, nullable=True)
    webui_jwt_expires_at = Column(Float, nullable=True)
    webui_user_id = Column(String(255), nullable=True)
    webui_password = Column(String(255), nullable=True)

    # Provisioning status: not_started | pending | completed | failed
    provisioning_status = Column(String(20), default="not_started")
    provisioning_error = Column(Text, nullable=True)
    provisioning_updated_at = Column(Float, nullable=True)


class AgentMetadata(Base):
    __tablename__ = "agent_metadata"
    __table_args__ = (
        Index("ix_agent_metadata_tags", "tags", postgresql_using="gin"),
        Index("ix_agent_metadata_skills", "skills", postgresql_using="gin"),
    )

    agent_number = Column(Integer, primary_key=True)
    display_name = Column(String(100), default="")
    tags = Column(JSONB, default=list, server_default="[]", nullable=False)
    role = Column(String(50), default="generalist", server_default="generalist", nullable=False)
    # --- Phase 0 new fields ---
    domain = Column(
        String(20),
        default="generalist",
        server_default="generalist",
        nullable=False,
    )
    skills = Column(
        JSONB,
        default=list,
        server_default="[]",
        nullable=False,
    )
    # --- end Phase 0 ---
    description = Column(Text, default="")
    # Resource specs (persisted from K8s for user-mode viewing)
    cpu_request = Column(String(20), default="250m", server_default="250m")
    cpu_limit = Column(String(20), default="1000m", server_default="1000m")
    memory_request = Column(String(20), default="512Mi", server_default="512Mi")
    memory_limit = Column(String(20), default="1Gi", server_default="1Gi")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AgentSkill(Base):
    """Per-agent skill records, populated by agent startup self-reporting."""
    __tablename__ = "agent_skills"
    __table_args__ = (
        UniqueConstraint("agent_number", "skill_name", name="ix_agent_skills_agent_skill"),
        Index("ix_agent_skills_tags", "tags", postgresql_using="gin"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    agent_number = Column(Integer, nullable=False, index=True)
    skill_name = Column(String(64), nullable=False)
    description = Column(String(1024), default="")
    version = Column(String(32), default="")
    tags = Column(JSONB, default=list, server_default="[]", nullable=False)
    skill_dir = Column(String(512), default="")
    reported_at = Column(DateTime(timezone=True), server_default=func.now())
    content_hash = Column(String(64), default="")


class ReportIdRecord(Base):
    """Idempotency dedup table for skill reports. Cleaned on startup (7-day TTL)."""
    __tablename__ = "skill_report_ids"

    report_id = Column(String(128), primary_key=True)
    agent_number = Column(Integer, nullable=False)
    skills_count = Column(Integer, default=0)
    tags_aggregated = Column(JSONB, default=list)
    processed_at = Column(DateTime(timezone=True), server_default=func.now())


class ProfileTemplate(Base):
    """Reusable profile templates that define config overrides and soul prompts."""
    __tablename__ = "profile_templates"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(64), unique=True, nullable=False)
    display_name = Column(String(100), default="")
    description = Column(Text, default="")
    config_overrides = Column(JSONB, default=dict, server_default="{}", nullable=False)
    soul_md = Column(Text, nullable=True)
    is_builtin = Column(Boolean, default=False, server_default="false", nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AgentProfile(Base):
    """Per-agent profile assignment, optionally derived from a template."""
    __tablename__ = "agent_profiles"
    __table_args__ = (
        UniqueConstraint("agent_number", "profile_name", name="uq_agent_profiles_agent_name"),
        Index("ix_agent_profiles_template_id", "template_id"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    agent_number = Column(Integer, nullable=False, index=True)
    template_id = Column(Integer, ForeignKey("profile_templates.id", ondelete="SET NULL"), nullable=True)
    profile_name = Column(String(64), nullable=False)
    display_name = Column(String(100), default="")
    config_overrides = Column(JSONB, default=dict, server_default="{}", nullable=False)
    soul_md = Column(Text, nullable=True)
    sync_status = Column(String(16), default="pending", server_default="pending", nullable=False)
    sync_error = Column(Text, nullable=True)
    config_hash = Column(String(64), nullable=True)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ProfileAuditLog(Base):
    """Audit log for profile/template CUD operations."""
    __tablename__ = "profile_audit_log"
    __table_args__ = (
        CheckConstraint("action IN ('create', 'update', 'delete')", name="ck_audit_action"),
        Index("ix_audit_entity", "entity_type", "entity_id"),
        Index("ix_audit_created", "created_at", postgresql_using="btree"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity_type = Column(String(16), nullable=False)  # 'template' | 'profile'
    entity_id = Column(Integer, nullable=False)
    action = Column(String(16), nullable=False)  # 'create' | 'update' | 'delete'
    old_values = Column(JSONB, nullable=True)
    new_values = Column(JSONB, nullable=True)
    changed_by = Column(String(64), default="admin-ui")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
