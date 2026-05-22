"""Database engine, session management, and startup migrations for Hermes Admin."""
from __future__ import annotations

import logging
import os
from typing import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

logger = logging.getLogger("hermes-admin.database")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://hermes:hermes_pg_2024@postgres:5432/hermes_admin",
)

engine = create_async_engine(DATABASE_URL, echo=False, pool_size=5, max_overflow=10, pool_pre_ping=True)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
AsyncSessionLocal = async_session


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


# ---------------------------------------------------------------------------
# Idempotent migrations — executed on every startup
# ---------------------------------------------------------------------------

_MIGRATION_SQL: list[str] = [
    # Phase 0: agent_metadata — add domain column
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS domain VARCHAR(20)
        NOT NULL DEFAULT 'generalist'
    """,
    # Phase 0: agent_metadata — add skills JSONB column
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS skills JSONB
        NOT NULL DEFAULT '[]'::jsonb
    """,
    # Phase 0: agent_metadata — ensure description column exists
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''
    """,
    # Phase 0: create agent_skills table
    """
    CREATE TABLE IF NOT EXISTS agent_skills (
        id SERIAL PRIMARY KEY,
        agent_number INTEGER NOT NULL,
        skill_name VARCHAR(64) NOT NULL,
        description VARCHAR(1024) DEFAULT '',
        version VARCHAR(32) DEFAULT '',
        tags JSONB DEFAULT '[]'::jsonb NOT NULL,
        skill_dir VARCHAR(512) DEFAULT '',
        reported_at TIMESTAMPTZ DEFAULT NOW(),
        content_hash VARCHAR(64) DEFAULT ''
    )
    """,
    # Phase 0: agent_skills unique constraint (idempotent via DO NOTHING)
    """
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ix_agent_skills_agent_skill'
      ) THEN
        ALTER TABLE agent_skills
          ADD CONSTRAINT ix_agent_skills_agent_skill
          UNIQUE (agent_number, skill_name);
      END IF;
    END
    $$;
    """,
    # Phase 0: agent_skills index on agent_number
    """
    CREATE INDEX IF NOT EXISTS ix_agent_skills_agent_number
      ON agent_skills (agent_number)
    """,
    # Phase 0: agent_skills GIN index on tags
    """
    CREATE INDEX IF NOT EXISTS ix_agent_skills_tags
      ON agent_skills USING gin (tags)
    """,
    # Phase 0: create skill_report_ids table
    """
    CREATE TABLE IF NOT EXISTS skill_report_ids (
        report_id VARCHAR(128) PRIMARY KEY,
        agent_number INTEGER NOT NULL,
        skills_count INTEGER DEFAULT 0,
        tags_aggregated JSONB DEFAULT '[]'::jsonb,
        processed_at TIMESTAMPTZ DEFAULT NOW()
    )
    """,
    # Phase 0: agent_metadata GIN index on skills
    """
    CREATE INDEX IF NOT EXISTS ix_agent_metadata_skills
      ON agent_metadata USING gin (skills)
    """,
    # Resource spec columns on agent_metadata
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS cpu_request VARCHAR(20) DEFAULT '250m'
    """,
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS cpu_limit VARCHAR(20) DEFAULT '1000m'
    """,
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS memory_request VARCHAR(20) DEFAULT '512Mi'
    """,
    """
    ALTER TABLE agent_metadata
      ADD COLUMN IF NOT EXISTS memory_limit VARCHAR(20) DEFAULT '1Gi'
    """,
    # agent_profiles: ensure sync_status has valid values
    """
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_agent_profiles_sync_status'
      ) THEN
        ALTER TABLE agent_profiles
          ADD CONSTRAINT chk_agent_profiles_sync_status
          CHECK (sync_status IN ('pending', 'synced', 'error'));
      END IF;
    END
 $$;
    """,
    # agent_profiles: FK to profile_templates with SET NULL on delete
    """
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_profiles_template_id'
      ) THEN
        ALTER TABLE agent_profiles
          ADD CONSTRAINT fk_agent_profiles_template_id
          FOREIGN KEY (template_id) REFERENCES profile_templates(id)
          ON DELETE SET NULL;
      END IF;
    END
 $$;
    """,
    # P2.12: profile_audit_log for template/profile CUD audit trail
    """
    CREATE TABLE IF NOT EXISTS profile_audit_log (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(16) NOT NULL,
        entity_id INTEGER NOT NULL,
        action VARCHAR(16) NOT NULL,
        old_values JSONB,
        new_values JSONB,
        changed_by VARCHAR(64) DEFAULT 'admin-ui',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_audit_entity
      ON profile_audit_log (entity_type, entity_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_audit_created
      ON profile_audit_log (created_at DESC)
    """,
    # CHECK constraint on profile_audit_log.action
    """
    ALTER TABLE profile_audit_log DROP CONSTRAINT IF EXISTS ck_audit_action
    """,
    # Clean up rows with invalid action values before re-adding constraint
    """
    DELETE FROM profile_audit_log WHERE action NOT IN ('create', 'update', 'delete')
    """,
    """
    ALTER TABLE profile_audit_log ADD CONSTRAINT ck_audit_action CHECK (action IN ('create', 'update', 'delete'))
    """,
    # --- Dispatch system tables ---
    """
    CREATE TABLE IF NOT EXISTS task_channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(64) UNIQUE NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        description TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS task_channel_subscriptions (
        id SERIAL PRIMARY KEY,
        channel_id BIGINT NOT NULL REFERENCES task_channels(id) ON DELETE CASCADE,
        agent_number INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_channel_agent UNIQUE (channel_id, agent_number)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_subscriptions_agent
      ON task_channel_subscriptions (agent_number)
    """,
    """
    CREATE TABLE IF NOT EXISTS dispatch_tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        prompt TEXT NOT NULL,
        instructions TEXT DEFAULT '',
        dispatch_type VARCHAR(20) NOT NULL,
        channel_id BIGINT REFERENCES task_channels(id) ON DELETE SET NULL,
        priority INTEGER DEFAULT 5,
        timeout_seconds INTEGER DEFAULT 600,
        confirm_timeout_hours INTEGER DEFAULT 24,
        profile_hint VARCHAR(64),
        status VARCHAR(20) DEFAULT 'pending' NOT NULL,
        created_by VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        result_summary TEXT,
        CONSTRAINT ck_dispatch_type CHECK (dispatch_type IN ('channel', 'direct')),
        CONSTRAINT ck_priority_range CHECK (priority BETWEEN 1 AND 10),
        CONSTRAINT ck_timeout_positive CHECK (timeout_seconds > 0),
        CONSTRAINT ck_confirm_timeout CHECK (confirm_timeout_hours BETWEEN 1 AND 168),
        CONSTRAINT ck_task_status CHECK (status IN ('pending','dispatching','dispatched','partial','completed','failed','cancelled'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_dispatch_status_created
      ON dispatch_tasks (status, created_at DESC)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_dispatch_channel
      ON dispatch_tasks (channel_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_dispatch_created_by
      ON dispatch_tasks (created_by)
    """,
    """
    CREATE TABLE IF NOT EXISTS dispatch_assignments (
        id SERIAL PRIMARY KEY,
        task_id BIGINT NOT NULL REFERENCES dispatch_tasks(id) ON DELETE CASCADE,
        agent_number INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' NOT NULL,
        user_confirmed_at TIMESTAMPTZ,
        profile_name VARCHAR(64),
        profile_source VARCHAR(20),
        orchestrator_task_id VARCHAR(128),
        callback_token_hash VARCHAR(128),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        result_summary TEXT,
        result_data JSONB,
        error_message TEXT,
        confirm_deadline TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_task_agent UNIQUE (task_id, agent_number),
        CONSTRAINT ck_assignment_status CHECK (status IN ('pending','notified','confirmed','rejected','executing','completed','failed','expired')),
        CONSTRAINT ck_profile_source CHECK (profile_source IS NULL OR profile_source IN ('user','auto','admin_hint'))
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_assignment_agent_status
      ON dispatch_assignments (agent_number, status)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_assignment_task_id
      ON dispatch_assignments (task_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS ix_assignment_deadline
      ON dispatch_assignments (confirm_deadline)
      WHERE status IN ('pending','notified')
    """,
    # Dispatch: add kanban_task_id column for status sync
    """
    ALTER TABLE dispatch_assignments
      ADD COLUMN IF NOT EXISTS kanban_task_id VARCHAR(128)
    """,
]

_CLEANUP_SQL: list[str] = [
    "DELETE FROM skill_report_ids WHERE processed_at < NOW() - INTERVAL '7 days'",
    "DELETE FROM profile_audit_log WHERE created_at < NOW() - INTERVAL '90 days'",
    "DELETE FROM dispatch_tasks WHERE created_at < NOW() - INTERVAL '90 days' AND status IN ('completed', 'failed', 'cancelled')",
]


async def _run_migrations() -> None:
    """Run idempotent migration SQL on every startup.

    Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so repeated execution is safe.
    Each statement runs in its own transaction so one failure does not abort the rest.
    """
    for sql in _MIGRATION_SQL:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
        except Exception as exc:
            logger.warning("Migration statement skipped: %s", exc)
    logger.info("Database migrations applied successfully")

    # Cleanup stale report-id records
    try:
        async with engine.begin() as conn:
            for sql in _CLEANUP_SQL:
                try:
                    result = await conn.execute(text(sql))
                    if result.rowcount:
                        logger.info("Cleanup: %d rows affected — %s", result.rowcount, sql[:80])
                except Exception as exc:
                    logger.warning("Cleanup statement skipped: %s", exc)
    except Exception as exc:
        logger.warning("Database cleanup skipped: %s", exc)


async def init_db() -> None:
    """Create tables on startup and run migrations."""
    from db_models import Base

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database tables initialized")
    except Exception as e:
        logger.warning("Database init failed (email login will be unavailable): %s", e)

    # Run idempotent migrations after create_all
    try:
        await _run_migrations()
    except Exception as e:
        logger.warning("Database migrations failed: %s", e)

    # Seed built-in profile templates
    try:
        async with async_session() as session:
            await _seed_builtin_templates(session)
            await session.commit()
    except Exception as e:
        logger.warning("Builtin template seeding failed: %s", e)


async def _seed_builtin_templates(session: AsyncSession) -> None:
    """Upsert built-in profile templates. Updates existing builtins on re-deploy."""
    import json

    _BASE_MODEL_CONFIG = json.dumps({"model": {"default": "glm-4.7", "provider": "custom"}})

    templates = [
        {
            "name": "researcher",
            "display_name": "Researcher",
            "description": "专注于深度调研、信息搜集与结构化分析的模板",
            "soul_md": "你是一个专业的调研分析师。你擅长从海量信息中提取关键洞察，进行系统性分析，并产出结构化的调研报告。你的回答需要基于事实、数据支撑，逻辑清晰，条理分明。",
            "config_overrides": json.dumps({
                "model": {"default": "glm-4.7", "provider": "custom"},
                "skills": {"install": ["skills-sh/obra/superpowers/skills/brainstorming"]},
            }),
        },
        {
            "name": "writer",
            "display_name": "Writer",
            "description": "专注于高质量内容创作与文案撰写的模板",
            "soul_md": "你是一个专业的内容写作者。你擅长各类文体的创作，包括但不限于技术文章、营销文案、产品说明、创意写作等。你注重文字表达的精准性和可读性，能够根据不同受众调整写作风格。",
            "config_overrides": _BASE_MODEL_CONFIG,
        },
        {
            "name": "analyst",
            "display_name": "Analyst",
            "description": "专注于数据分析、业务洞察与决策支持的模板",
            "soul_md": "你是一个数据与业务分析师。你擅长从数据中发现模式和趋势，构建分析框架，提供基于数据的决策建议。你熟悉各类分析方法论，能够将复杂的数据转化为易于理解的洞察。",
            "config_overrides": _BASE_MODEL_CONFIG,
        },
        {
            "name": "backend-eng",
            "display_name": "Backend Engineer",
            "description": "专注于后端开发、系统架构与工程实践的模板",
            "soul_md": "你是一个后端开发工程师。你精通 Python、Go 等后端语言，熟悉数据库设计、API 开发、微服务架构、容器化部署等技术栈。你注重代码质量、系统可靠性和可维护性。",
            "config_overrides": json.dumps(
                {"model": {"default": "glm-4.7", "provider": "custom"}, "terminal": {"timeout": 300}}
            ),
        },
        {
            "name": "reviewer",
            "display_name": "Reviewer",
            "description": "专注于代码审查、架构评审与质量把控的模板",
            "soul_md": "你是一个专业的代码审查员。你擅长发现代码中的潜在问题、安全漏洞和性能瓶颈。你的审查意见基于最佳实践和工程标准，注重可读性、可维护性和健壮性。",
            "config_overrides": json.dumps({
                "model": {"default": "glm-4.7", "provider": "custom"},
                "skills": {"enabled": ["web-search"], "disabled": ["file-upload"], "install": []},
            }),
        },
        {
            "name": "tester",
            "display_name": "Tester",
            "description": "专注于测试工程、质量保障与自动化测试的模板",
            "soul_md": "你是一个测试工程师。你精通单元测试、集成测试、E2E测试等各类测试方法论，擅长设计测试策略、编写测试用例、构建自动化测试流水线。你关注边界条件和异常场景的覆盖。",
            "config_overrides": json.dumps({
                "model": {"default": "glm-4.7", "provider": "custom"},
                "skills": {"enabled": ["web-search", "code-exec"], "disabled": [], "install": ["skills-sh/obra/superpowers/skills/systematic-debugging"]},
            }),
        },
        {
            "name": "frontend-eng",
            "display_name": "Frontend Engineer",
            "description": "专注于前端开发、UI/UX 实现与 Web 性能优化的模板",
            "soul_md": "你是一个前端开发工程师。你精通 React、Vue、TypeScript 等现代前端技术栈，熟悉 CSS 动画、响应式设计、Web 性能优化。你注重用户体验、代码规范和组件化架构。",
            "config_overrides": json.dumps({
                "model": {"default": "glm-4.7", "provider": "custom"},
                "skills": {"enabled": ["web-search", "code-exec", "file-upload"], "disabled": [], "install": ["skills-sh/obra/superpowers/skills/writing-plans"]},
            }),
        },
    ]

    for tpl in templates:
        await session.execute(
            text(
                """
                INSERT INTO profile_templates
                    (name, display_name, description, soul_md, config_overrides, is_builtin)
                VALUES
                    (:name, :display_name, :description, :soul_md, CAST(:config_overrides AS jsonb), true)
                ON CONFLICT (name) DO UPDATE SET
                    config_overrides = CAST(EXCLUDED.config_overrides AS jsonb),
                    display_name = EXCLUDED.display_name,
                    description = EXCLUDED.description,
                    soul_md = EXCLUDED.soul_md,
                    updated_at = NOW()
                WHERE profile_templates.is_builtin = true
                """
            ),
            {
                "name": tpl["name"],
                "display_name": tpl["display_name"],
                "description": tpl["description"],
                "soul_md": tpl["soul_md"],
                "config_overrides": tpl["config_overrides"],
            },
        )
    logger.info("Builtin profile templates seeded")
