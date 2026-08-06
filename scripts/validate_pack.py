#!/usr/bin/env python3
"""Validate the bundled Backblaze B2 skills pack."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


REQUIRED_SECTIONS = (
    "When To Use",
    "Tools Used",
    "Byte Path",
    "Safety Gates",
    "Playbook",
)
FRONTMATTER_RE = re.compile(r"\A---\r?\n(?P<body>.*?)\r?\n---\r?\n", re.DOTALL)
H2_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
TOOL_REF_RE = re.compile(r"`((?:b2|bz|s3)_[a-z0-9_]+)`")
TOOL_BULLET_RE = re.compile(r"^\s*-\s*`((?:b2|bz|s3)_[a-z0-9_]+)`", re.MULTILINE)
TRIGGER_RE = re.compile(r"^\s*-\s*Trigger\s*:", re.MULTILINE)

BYTE_PATH_REQUIRED_PHRASES = (
    "never route object bytes through the model",
    "never route object bytes through the mcp server",
)
BYTE_PATH_HANDOFF_TERMS = (
    "client-to-b2",
    "presigned url",
    "presigned urls",
    "server-side copy",
    "no object bytes are involved",
)


@dataclass(frozen=True)
class ToolContract:
    known_tools: frozenset[str]
    gated_tools: frozenset[str]


def parse_frontmatter(text: str, location: str) -> tuple[dict[str, str], str, list[str]]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, text, [f"{location}: missing YAML-style frontmatter"]

    metadata: dict[str, str] = {}
    errors: list[str] = []
    for index, raw_line in enumerate(match.group("body").splitlines(), start=2):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            errors.append(f"{location}:{index}: invalid frontmatter line")
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            errors.append(f"{location}:{index}: empty frontmatter key")
            continue
        metadata[key] = value

    return metadata, text[match.end() :], errors


def sections(markdown: str) -> dict[str, str]:
    matches = list(H2_RE.finditer(markdown))
    result: dict[str, str] = {}
    for index, match in enumerate(matches):
        title = match.group("title").strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        result[title] = markdown[start:end].strip()
    return result


def ordered_unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def load_contract(path: Path) -> ToolContract:
    data = json.loads(path.read_text(encoding="utf-8"))
    try:
        full_profile = data["profiles"]["full"]
        names = set(full_profile["names"])
    except KeyError as exc:
        raise ValueError(f"{path}: missing profiles.full.{exc.args[0]}") from exc

    confirm_tools = set(full_profile.get("confirmTools", []))
    destructive_confirm_tools = set(full_profile.get("destructiveConfirmTools", []))
    gated_tools = confirm_tools | destructive_confirm_tools
    unknown_gates = sorted(gated_tools - names)
    if unknown_gates:
        raise ValueError(
            f"{path}: gated tools are not present in full tool surface: {', '.join(unknown_gates)}"
        )

    return ToolContract(known_tools=frozenset(names), gated_tools=frozenset(gated_tools))


def validate_metadata(
    metadata: dict[str, str],
    skill_path: Path,
    skills_dir: Path,
    errors: list[str],
) -> None:
    rel = skill_path.relative_to(skills_dir.parent).as_posix()
    name = metadata.get("name", "").strip()
    description = metadata.get("description", "").strip()

    if not name:
        errors.append(f"{rel}: frontmatter requires non-empty name")
    elif not SKILL_NAME_RE.fullmatch(name):
        errors.append(f"{rel}: skill name must match {SKILL_NAME_RE.pattern}")
    elif skill_path.parent.name != name:
        errors.append(f"{rel}: skill directory must match frontmatter name '{name}'")

    if not description:
        errors.append(f"{rel}: frontmatter requires non-empty description")


def validate_sections(section_map: dict[str, str], rel: str, errors: list[str]) -> None:
    for title in REQUIRED_SECTIONS:
        if not section_map.get(title):
            errors.append(f"{rel}: missing required section '## {title}'")

    if "When To Use" in section_map and not TRIGGER_RE.search(section_map["When To Use"]):
        errors.append(f"{rel}: When To Use must include at least one '- Trigger:' bullet")


def validate_tools(
    markdown: str,
    section_map: dict[str, str],
    rel: str,
    contract: ToolContract,
    errors: list[str],
) -> list[str]:
    used_tools = ordered_unique(TOOL_BULLET_RE.findall(section_map.get("Tools Used", "")))
    if not used_tools:
        errors.append(f"{rel}: Tools Used must list at least one backticked MCP tool")

    referenced_tools = set(TOOL_REF_RE.findall(markdown))
    unlisted = sorted(referenced_tools - set(used_tools))
    if unlisted:
        errors.append(f"{rel}: tool references missing from Tools Used: {', '.join(unlisted)}")

    unknown = sorted(set(used_tools) - contract.known_tools)
    if unknown:
        errors.append(f"{rel}: tool references are not in the full tool surface: {', '.join(unknown)}")

    return used_tools


def validate_byte_path(section_map: dict[str, str], rel: str, errors: list[str]) -> None:
    body = section_map.get("Byte Path", "")
    lower = body.lower()
    for phrase in BYTE_PATH_REQUIRED_PHRASES:
        if phrase not in lower:
            errors.append(f"{rel}: Byte Path must state '{phrase}'")
    if not any(term in lower for term in BYTE_PATH_HANDOFF_TERMS):
        errors.append(
            f"{rel}: Byte Path must name a direct handoff such as presigned URLs, "
            "client-to-B2 transfer, server-side copy, or no object bytes involved"
        )


def validate_safety_gates(
    section_map: dict[str, str],
    rel: str,
    used_tools: list[str],
    contract: ToolContract,
    errors: list[str],
) -> None:
    body = section_map.get("Safety Gates", "")
    lower = body.lower()
    gated_used = sorted(set(used_tools) & contract.gated_tools)

    if "pause" not in lower:
        errors.append(f"{rel}: Safety Gates must require a pause before risky actions")
    if "explicit user confirmation" not in lower:
        errors.append(f"{rel}: Safety Gates must require explicit user confirmation")
    if "b2_destructive_policy" not in lower:
        errors.append(f"{rel}: Safety Gates must reference B2_DESTRUCTIVE_POLICY")

    if gated_used:
        if "confirm: true" not in lower and '"confirm": true' not in lower:
            errors.append(f"{rel}: Safety Gates must describe confirm: true for gated tools")
        for tool in gated_used:
            if f"`{tool}`" not in body:
                errors.append(f"{rel}: missing safety gate for {tool}")
    elif "no destructive or protection-weakening tools" not in lower:
        errors.append(
            f"{rel}: Safety Gates must explicitly say no destructive or protection-weakening "
            "tools are used when no gated tool is listed"
        )


def validate_skill(skill_path: Path, skills_dir: Path, contract: ToolContract) -> list[str]:
    rel = skill_path.relative_to(skills_dir.parent).as_posix()
    text = skill_path.read_text(encoding="utf-8")
    metadata, markdown, errors = parse_frontmatter(text, rel)

    validate_metadata(metadata, skill_path, skills_dir, errors)
    section_map = sections(markdown)
    validate_sections(section_map, rel, errors)
    used_tools = validate_tools(markdown, section_map, rel, contract, errors)
    validate_byte_path(section_map, rel, errors)
    validate_safety_gates(section_map, rel, used_tools, contract, errors)

    return errors


def skill_files(skills_dir: Path) -> list[Path]:
    return sorted(path for path in skills_dir.glob("*/SKILL.md") if path.is_file())


def validate_pack(root: Path, skills_dir: Path, contract_path: Path) -> list[str]:
    errors: list[str] = []
    if not skills_dir.is_dir():
        return [f"{skills_dir.relative_to(root).as_posix()}: skills directory is missing"]

    try:
        contract = load_contract(contract_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return [str(exc)]

    skills = skill_files(skills_dir)
    if not skills:
        return [f"{skills_dir.relative_to(root).as_posix()}: no */SKILL.md files found"]

    names: dict[str, Path] = {}
    for skill_path in skills:
        text = skill_path.read_text(encoding="utf-8")
        metadata, _, parse_errors = parse_frontmatter(
            text, skill_path.relative_to(skills_dir.parent).as_posix()
        )
        name = metadata.get("name", "")
        if name:
            if name in names:
                errors.append(
                    f"{skill_path.relative_to(root).as_posix()}: duplicate skill name '{name}' "
                    f"also used by {names[name].relative_to(root).as_posix()}"
                )
            names[name] = skill_path
        if parse_errors:
            errors.extend(parse_errors)

    for skill_path in skills:
        errors.extend(validate_skill(skill_path, skills_dir, contract))

    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--skills-dir", type=Path)
    parser.add_argument("--contract", type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    skills_dir = (args.skills_dir or root / "skills").resolve()
    contract_path = (args.contract or root / "docs" / "tool-profile-contract.json").resolve()

    errors = validate_pack(root, skills_dir, contract_path)
    if errors:
        for error in errors:
            print(f"validate_pack: {error}", file=sys.stderr)
        return 1

    count = len(skill_files(skills_dir))
    print(f"validate_pack: validated {count} skill(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
