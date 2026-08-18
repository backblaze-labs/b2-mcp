#!/usr/bin/env python3
"""Validate the bundled B2 skills pack.

The skills are client-side Markdown playbooks, but they must track the MCP
server's published tools and destructive gates. This validator intentionally
uses only the standard library so it can run in CI without extra dependencies.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


DEFAULT_ROOT = Path(__file__).resolve().parents[1]

PACK_MANIFEST_PATH = Path("skills/pack.json")
PHASE1_SKILL_NAMES = {
    "b2-backup-restore",
    "b2-incident-response",
    "b2-least-privilege-keys",
    "b2-lifecycle-cost-hygiene",
    "b2-migration",
    "b2-object-lock",
}
REQUIRED_SECTIONS = (
    "When to use",
    "Byte path",
    "Safety gates",
    "Tools used",
    "Playbook",
)
TOOL_RE = re.compile(r"\b(?:b2|s3|bz)_[a-z0-9_]+\b")
BYTE_SUBJECT_RE = re.compile(
    r"\b(?:object\s+(?:data|bytes|contents?|bodies|payloads?)|bulk\s+object\s+bytes)\b",
    re.I,
)
BYTE_ROUTE_VERB_RE = re.compile(
    r"\b(?:route|send|move|transfer|flow|stream|pass|enter|reach|upload|download|relay|forward)\b",
    re.I,
)
BYTE_NEGATION_RE = re.compile(r"\b(?:must\s+not|never|do\s+not|don't|no)\b", re.I)
MODEL_OR_SERVER_DEST_RE = re.compile(r"\b(?:model|chat|mcp\s+server|server)\b", re.I)
DIRECT_TO_B2_RE = re.compile(
    r"\bdirect(?:ly)?\b.{0,140}\b(?:client|workload|worker)\b.{0,140}\bb2\b"
    r"|\b(?:client|workload|worker)\b.{0,140}\bdirect(?:ly)?\b.{0,140}\bb2\b",
    re.I | re.S,
)
NEGATED_DIRECT_TO_B2_RE = re.compile(
    r"\b(?:must\s+not|never|do\s+not|don't|no)\b.{0,100}\bdirect(?:ly)?\b"
    r"|\bdirect(?:ly)?\b.{0,100}\b(?:must\s+not|never|do\s+not|don't|no)\b",
    re.I | re.S,
)
CONFIRMATION_GATE_RE = re.compile(
    r"\b(?:pause|stop|ask|require|requires|requiring)\b.{0,160}"
    r"\b(?:explicit\s+)?(?:confirmation|approval)\b"
    r"|\b(?:explicit\s+)?(?:confirmation|approval)\b.{0,160}"
    r"\b(?:pause|stop|ask|require|requires|requiring)\b",
    re.I | re.S,
)
NEGATED_GATE_RE = re.compile(
    r"\b(?:do\s+not|don't|never|without|skip|no\s+need\s+to)\b.{0,90}"
    r"\b(?:pause|confirm|confirmation|approval)\b"
    r"|\b(?:pause|confirm|confirmation|approval)\b.{0,90}"
    r"\b(?:not\s+required|unnecessary|optional)\b",
    re.I | re.S,
)
SECRET_PATH_PARTS = {
    ".env",
    ".env.local",
    ".npmrc",
    "credentials",
    "secrets",
    "private.key",
}
SECRET_VALUE_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(
        r"\b(?:B2_APPLICATION_KEY|B2_MASTER_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN)\s*[:=]",
        re.I,
    ),
    re.compile(
        r"\b(?:applicationKey|application_key|secretAccessKey|privateKey|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{12,}",
        re.I,
    ),
)


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


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        fail(f"{path}: invalid JSON: {err}")


def load_contract(root: Path) -> tuple[set[str], set[str]]:
    contract_path = root / "docs" / "tool-profile-contract.json"
    contract = load_json(contract_path)
    if not isinstance(contract, dict):
        fail(f"{contract_path}: expected JSON object")
    full_profile = contract.get("profiles", {}).get("full")
    if not isinstance(full_profile, dict):
        fail(f"{contract_path}: missing profiles.full")
    names = full_profile.get("names")
    destructive = full_profile.get("destructiveConfirmTools")
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        fail(f"{contract_path}: profiles.full.names must be a string array")
    if not isinstance(destructive, list) or not all(isinstance(name, str) for name in destructive):
        fail(f"{contract_path}: profiles.full.destructiveConfirmTools must be a string array")
    destructive_tools = set(destructive)
    if not destructive_tools:
        fail(f"{contract_path}: destructiveConfirmTools must not be empty")
    if not destructive_tools.issubset(set(names)):
        fail(f"{contract_path}: destructiveConfirmTools contains tools missing from names")
    return set(names), destructive_tools


def load_manifest(root: Path) -> tuple[list[dict[str, str]], set[str]]:
    manifest_path = root / PACK_MANIFEST_PATH
    manifest = load_json(manifest_path)
    if not isinstance(manifest, dict):
        fail(f"{manifest_path}: expected JSON object")
    if manifest.get("schemaVersion") != 1:
        fail(f"{manifest_path}: schemaVersion must be 1")
    skills = manifest.get("skills")
    if not isinstance(skills, list) or not skills:
        fail(f"{manifest_path}: skills must be a non-empty array")

    normalized: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for index, skill in enumerate(skills):
        if not isinstance(skill, dict):
            fail(f"{manifest_path}: skills[{index}] must be an object")
        name = skill.get("name")
        path = skill.get("path")
        if not isinstance(name, str) or not re.fullmatch(r"b2-[a-z0-9-]+", name):
            fail(f"{manifest_path}: skills[{index}].name must be a b2-* slug")
        if not isinstance(path, str) or path != f"{name}/SKILL.md":
            fail(f"{manifest_path}: skills[{index}].path must be {name}/SKILL.md")
        if name in seen_names:
            fail(f"{manifest_path}: duplicate skill name {name}")
        seen_names.add(name)
        normalized.append({"name": name, "path": path})

    if seen_names != PHASE1_SKILL_NAMES:
        fail(
            f"{manifest_path}: skills must declare the Phase 1 pack exactly; "
            f"missing={sorted(PHASE1_SKILL_NAMES - seen_names)} "
            f"unexpected={sorted(seen_names - PHASE1_SKILL_NAMES)}"
        )

    expected_package_files = {PACK_MANIFEST_PATH.as_posix()} | {
        f"skills/{skill['path']}" for skill in normalized
    }
    package_files = manifest.get("packageFiles")
    if not isinstance(package_files, list) or not all(isinstance(item, str) for item in package_files):
        fail(f"{manifest_path}: packageFiles must be a string array")
    if set(package_files) != expected_package_files:
        fail(
            f"{manifest_path}: packageFiles must match declared skills exactly; "
            f"missing={sorted(expected_package_files - set(package_files))} "
            f"unexpected={sorted(set(package_files) - expected_package_files)}"
        )
    return normalized, expected_package_files


def validate_package_allowlist(root: Path, expected_package_files: set[str]) -> None:
    package_json_path = root / "package.json"
    package_json = load_json(package_json_path)
    if not isinstance(package_json, dict):
        fail(f"{package_json_path}: expected JSON object")
    files = package_json.get("files")
    if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
        fail(f"{package_json_path}: files must be a string array")
    package_file_set = set(files)
    skill_package_entries = {item for item in package_file_set if item.startswith("skills/")}
    if any("*" in item for item in skill_package_entries):
        fail(f"{package_json_path}: skills package entries must be explicit, not globs")
    if skill_package_entries != expected_package_files:
        fail(
            f"{package_json_path}: files must package the validated skill manifest exactly; "
            f"missing={sorted(expected_package_files - skill_package_entries)} "
            f"unexpected={sorted(skill_package_entries - expected_package_files)}"
        )


def validate_skill_tree(root: Path, expected_package_files: set[str]) -> None:
    skills_root = root / "skills"
    if not skills_root.is_dir():
        fail("skills directory is missing")
    actual_files = {
        path.relative_to(root).as_posix()
        for path in skills_root.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_package_files:
        fail(
            "skills directory must contain only manifest-declared packaged files; "
            f"missing={sorted(expected_package_files - actual_files)} "
            f"unexpected={sorted(actual_files - expected_package_files)}"
        )
    for relative_path in sorted(actual_files):
        validate_no_secret_like_content(root / relative_path, relative_path)


def validate_no_secret_like_content(path: Path, relative_path: str) -> None:
    parts = {part.lower() for part in Path(relative_path).parts}
    if parts & SECRET_PATH_PARTS:
        fail(f"{relative_path}: secret-like path is not allowed in bundled skills")
    text = path.read_text(encoding="utf-8")
    for pattern in SECRET_VALUE_PATTERNS:
        if pattern.search(text):
            fail(f"{relative_path}: secret-like content is not allowed in bundled skills")


def text_units(section: str) -> list[str]:
    units: list[str] = []
    current: list[str] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("- "):
            if current:
                units.append(" ".join(current))
            current = [stripped[2:].strip()]
        elif current:
            current.append(stripped)
    if current:
        units.append(" ".join(current))
    if units:
        return units
    return [unit.strip() for unit in re.split(r"(?<=[.!?])\s+", section) if unit.strip()]


def sentence_units(section: str) -> list[str]:
    units: list[str] = []
    for unit in text_units(section):
        units.extend(part.strip() for part in re.split(r"(?<=[.!?])\s+", unit) if part.strip())
    return units


def forbids_object_data_to_model_or_server(unit: str) -> bool:
    for clause in re.split(r"[;]\s*", unit):
        route_match = BYTE_ROUTE_VERB_RE.search(clause)
        dest_match = MODEL_OR_SERVER_DEST_RE.search(clause)
        negation_match = BYTE_NEGATION_RE.search(clause)
        if not (route_match and dest_match and negation_match and BYTE_SUBJECT_RE.search(clause)):
            continue
        if negation_match.start() < route_match.start() and negation_match.start() < dest_match.start():
            return True
    return False


def allows_object_data_to_model_or_server(unit: str) -> bool:
    for clause in re.split(r"[;]\s*", unit):
        route_match = BYTE_ROUTE_VERB_RE.search(clause)
        if not (
            route_match
            and BYTE_SUBJECT_RE.search(clause)
            and MODEL_OR_SERVER_DEST_RE.search(clause)
        ):
            continue
        if not BYTE_NEGATION_RE.search(clause[: route_match.start()]):
            return True
    return False


def requires_direct_object_data_to_b2(unit: str) -> bool:
    return (
        bool(BYTE_SUBJECT_RE.search(unit))
        and bool(DIRECT_TO_B2_RE.search(unit))
        and not NEGATED_DIRECT_TO_B2_RE.search(unit)
    )


def requires_confirmation_gate(unit: str) -> bool:
    return bool(CONFIRMATION_GATE_RE.search(unit)) and not NEGATED_GATE_RE.search(unit)


def validate_skill(
    root: Path,
    path: Path,
    expected_name: str,
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
    if name != expected_name:
        fail(f"{path}: frontmatter name must match manifest name {expected_name}")
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

    byte_path = sections["Byte path"]
    byte_units = sentence_units(byte_path)
    if not any(BYTE_SUBJECT_RE.search(unit) for unit in byte_units):
        fail(f"{path}: Byte path must discuss object data/bytes")
    if any(allows_object_data_to_model_or_server(unit) for unit in byte_units):
        fail(f"{path}: Byte path must not allow object bytes into the model/chat/MCP server")
    if not any(forbids_object_data_to_model_or_server(unit) for unit in byte_units):
        fail(f"{path}: Byte path must forbid object bytes from entering the model/chat/MCP server")
    if not any(requires_direct_object_data_to_b2(unit) for unit in byte_units):
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
        fail(
            f"{path}: tools mentioned outside Tools used must also be listed there: "
            f"{', '.join(sorted(undeclared_tools))}"
        )

    safety_gates = sections["Safety gates"]
    safety_units = text_units(safety_gates)
    if not any(requires_confirmation_gate(unit) for unit in safety_units):
        fail(f"{path}: Safety gates must include at least one explicit confirmation gate")
    destructive_used = declared_tools & destructive_tools
    for tool in sorted(destructive_used):
        matching_units = [unit for unit in safety_units if tool in unit]
        if not matching_units:
            fail(f"{path}: Safety gates must mention destructive tool {tool}")
        if not any(requires_confirmation_gate(unit) for unit in matching_units):
            fail(
                f"{path}: Safety gate for {tool} must require pause/explicit confirmation "
                "in the same bullet or sentence"
            )

    if not path.is_relative_to(root / "skills"):
        fail(f"{path}: skill must live under skills/")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate the bundled B2 skills pack.")
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="Repository root to validate (used by negative tests).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = args.root.resolve()

    all_tools, contract_gates = load_contract(root)
    manifest_skills, expected_package_files = load_manifest(root)
    validate_package_allowlist(root, expected_package_files)
    validate_skill_tree(root, expected_package_files)

    names_seen: set[str] = set()
    for skill in manifest_skills:
        validate_skill(
            root,
            root / "skills" / skill["path"],
            skill["name"],
            all_tools,
            contract_gates,
            names_seen,
        )

    print(
        f"Validated {len(manifest_skills)} B2 skills against {len(all_tools)} tools "
        f"and {len(contract_gates)} destructive gates."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
