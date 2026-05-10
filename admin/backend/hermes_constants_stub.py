"""Minimal stub for hermes_constants — admin container does not have the full
Hermes package installed.  Only provides the symbols that skills_hub_core
lazy-imports via ``from hermes_constants import ...``.
"""
from pathlib import Path
import os


def get_hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", "/opt/data"))


def get_optional_skills_dir(default: Path | None = None) -> Path:
    override = os.environ.get("HERMES_OPTIONAL_SKILLS", "").strip()
    if override:
        return Path(override)
    if default is not None:
        return default
    return get_hermes_home() / "optional-skills"
