#!/usr/bin/env python3
"""Validate the bundled B2 skills pack.

The skills are client-side Markdown playbooks, but they must track the MCP
server's published tools and destructive gates. This validator intentionally
uses only the standard library so it can run in CI without extra dependencies.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = ROOT / "skills"
CONTRACT_PATH = ROOT / "docs" / "tool-profile-contract.json"
DESTRUCTIVE_GATE_PATH = ROOT / "src" / "utils" / "destructive-gate.ts"

MIN_SKILLS = 6
REQUIRED_SECTIONS = (
    "When to use",
    "Byte path",
    "Safety gates",
    "Tools used",
    "Playbook",
)
TOOL_RE = re.compile(r"\b(?:b2|s3|bz)_[a-z0-9_]+\b")


def fail(message: str) -> None:
    print(f"validate_pack: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_frontmatter(text: str, path: Path) -> dict[str, str]:
    match = re.match(r"\A---\n(.*?)\n---\n", text, re.S)
    if not match:
        fail(f"{path}: missing YAML frontmatter")

    values: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line.strip():
            continue
        key, separator, value = line.partition(":")
        if separator != ":":
            fail(f"{path}: invalid frontmatter line: {line}")
        values[key.strip()] = value.strip().strip('"')
    return values


def section_bodies(text: str) -> dict[str, str]:
    headings = list(re.finditer(r"^##\s+(.+?)\s*$", text, re.M))
    sections: dict[str, str] = {}
    for index, heading in enumerate(headings):
        start = heading.end()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        sections[heading.group(1).strip()] = text[start:end].strip()
    return sections


def contract_tool_names() -> set[str]:
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    return set(contract["profiles"]["full"]["names"])


def contract_destructive_tools() -> set[str]:
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    return set(contract["profiles"]["full"]["destructiveConfirmTools"])


def source_destructive_tools() -> set[str]:
    source = DESTRUCTIVE_GATE_PATH.read_text(encoding="utf-8")
    match = re.search(
        r"const DETECTORS: Record<string, Detector> = \{(?P<body>.*?)\n\};",
        source,
        re.S,
    )
    if not match:
        fail(f"{DESTRUCTIVE_GATE_PATH}: could not locate DETECTORS registry")
    return set(re.findall(r"^\s{2}([a-z][a-z0-9_]*):", match.group("body"), re.M))


def validate_skill(
    path: Path,
    all_tools: set[str],
    destructive_tools: set[str],
    names_seen: set[str],
) -> None:
    text = path.read_text(encoding="utf-8")
    frontmatter = parse_frontmatter(text, path)
    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    if not re.fullmatch(r"b2-[a-z0-9-]+", name):
        fail(f"{path}: frontmatter name must be a b2-* slug")
    if name in names_seen:
        fail(f"{path}: duplicate skill name {name}")
    names_seen.add(name)
    if path.parent.name != name:
        fail(f"{path}: parent directory must match skill name {name}")
    if len(description) < 40:
        fail(f"{path}: description must be at least 40 characters")

    sections = section_bodies(text)
    missing = [section for section in REQUIRED_SECTIONS if section not in sections]
    if missing:
        fail(f"{path}: missing required sections: {', '.join(missing)}")

    when_to_use = sections["When to use"]
    if not re.search(r"(?m)^-\s+\S", when_to_use):
        fail(f"{path}: When to use must include explicit bullet triggers")

    byte_path = sections["Byte path"].lower()
    if "must not route object data through the model or mcp server" not in byte_path:
        fail(f"{path}: Byte path must forbid routing object data through the model or MCP server")
    if "directly between the client" not in byte_path or "b2" not in byte_path:
        fail(f"{path}: Byte path must require direct client/workload-to-B2 transfer")

    declared_tools = set(TOOL_RE.findall(sections["Tools used"]))
    mentioned_tools = set(TOOL_RE.findall(text))
    if not declared_tools:
        fail(f"{path}: Tools used must list at least one b2_* or s3_* tool")
    unknown_tools = mentioned_tools - all_tools
    if unknown_tools:
        fail(f"{path}: unknown tool references: {', '.join(sorted(unknown_tools))}")
    undeclared_tools = mentioned_tools - declared_tools
    if undeclared_tools:
        fail(f"{path}: tools mentioned outside Tools used must also be listed there: {', '.join(sorted(undeclared_tools))}")

    safety_gates = sections["Safety gates"].lower()
    if "pause" not in safety_gates or "confirmation" not in safety_gates:
        fail(f"{path}: Safety gates must pause for explicit confirmation")

    destructive_used = declared_tools & destructive_tools
    if destructive_used and "confirm" not in safety_gates:
        fail(f"{path}: destructive tool use must mention the server confirm gate")
    for tool in sorted(destructive_used):
        if tool not in sections["Safety gates"]:
            fail(f"{path}: Safety gates must mention destructive tool {tool}")


def main() -> int:
    if not SKILLS_ROOT.is_dir():
        fail("skills directory is missing")

    all_tools = contract_tool_names()
    contract_gates = contract_destructive_tools()
    source_gates = source_destructive_tools()
    if contract_gates != source_gates:
        missing_from_contract = source_gates - contract_gates
        stale_in_contract = contract_gates - source_gates
        fail(
            "destructive gate drift between docs/tool-profile-contract.json and "
            f"src/utils/destructive-gate.ts; missing={sorted(missing_from_contract)} "
            f"stale={sorted(stale_in_contract)}"
        )

    skill_paths = sorted(SKILLS_ROOT.glob("*/SKILL.md"))
    if len(skill_paths) < MIN_SKILLS:
        fail(f"expected at least {MIN_SKILLS} skills, found {len(skill_paths)}")

    names_seen: set[str] = set()
    for path in skill_paths:
        validate_skill(path, all_tools, contract_gates, names_seen)

    print(
        f"Validated {len(skill_paths)} B2 skills against {len(all_tools)} tools "
        f"and {len(contract_gates)} destructive gates."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
