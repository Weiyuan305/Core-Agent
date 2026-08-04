#!/usr/bin/env python3
"""Fixed, no-network Hermes Profile initializer owned by the product image."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit


DEFAULT_BUNDLE = Path("/run/core-agent/bootstrap/bundle.json")
DEFAULT_DATA_ROOT = Path("/opt/data")
DEFAULT_MANIFEST = Path("/opt/data/.core-agent/manifest.json")
DEFAULT_SECRET_ROOT = Path("/run/core-agent/secrets")
APPROVED_MODEL_ID = "cywx/gpt-5.6-sol"
MAX_PROFILES = 64
MAX_SECRET_BYTES = 16_384
OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
PROFILE_REF = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
IMAGE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*@sha256:[a-f0-9]{64}$")


class InitializerError(Exception):
    """A bounded validation or initialization failure."""


def closed_object(value: object, keys: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict or set(value) != keys:
        raise InitializerError(f"{label} has an invalid shape")
    return value


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise InitializerError("Bundle contains a duplicate JSON property")
        result[key] = value
    return result


def load_json(path: Path) -> object:
    try:
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream, object_pairs_hook=reject_duplicate_keys)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise InitializerError("Bundle or manifest JSON is unavailable or invalid") from error


def require_string(value: object, label: str, maximum: int) -> str:
    if type(value) is not str or not value or len(value) > maximum or "\x00" in value:
        raise InitializerError(f"{label} is invalid")
    return value


def require_id(value: object, label: str) -> str:
    identifier = require_string(value, label, 128)
    if OPAQUE_ID.fullmatch(identifier) is None:
        raise InitializerError(f"{label} is invalid")
    return identifier


def validate_provider_url(value: object) -> str:
    url = require_string(value, "provider_base_url", 2_000)
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or "\r" in url
        or "\n" in url
    ):
        raise InitializerError("provider_base_url is invalid")
    return url


def validate_profile(value: object) -> dict[str, object]:
    profile = closed_object(value, {
        "profile_id",
        "hermes_profile_ref",
        "description",
        "provider_base_url",
        "model_id",
        "provider_secret_file",
    }, "Profile")
    profile_id = require_id(profile["profile_id"], "profile_id")
    profile_ref = require_string(profile["hermes_profile_ref"], "hermes_profile_ref", 63)
    if PROFILE_REF.fullmatch(profile_ref) is None:
        raise InitializerError("hermes_profile_ref is invalid")
    description = require_string(profile["description"], "description", 2_000)
    provider_base_url = validate_provider_url(profile["provider_base_url"])
    model_id = require_string(profile["model_id"], "model_id", 255)
    if model_id != APPROVED_MODEL_ID:
        raise InitializerError("model_id is not approved")
    secret_file = require_string(profile["provider_secret_file"], "provider_secret_file", 4_096)
    return {
        "profile_id": profile_id,
        "hermes_profile_ref": profile_ref,
        "description": description,
        "provider_base_url": provider_base_url,
        "model_id": model_id,
        "provider_secret_file": secret_file,
    }


def validate_bundle(value: object) -> dict[str, object]:
    document = closed_object(value, {
        "bundle_version",
        "tenant_id",
        "runtime_id",
        "generation",
        "image_ref",
        "profiles",
    }, "RuntimeBootstrapBundle")
    if document["bundle_version"] != 1 or type(document["bundle_version"]) is not int:
        raise InitializerError("bundle_version is invalid")
    tenant_id = require_id(document["tenant_id"], "tenant_id")
    runtime_id = require_id(document["runtime_id"], "runtime_id")
    generation = document["generation"]
    if type(generation) is not int or generation < 1 or generation > 2_147_483_647:
        raise InitializerError("generation is invalid")
    image_ref = require_string(document["image_ref"], "image_ref", 512)
    if IMAGE_REF.fullmatch(image_ref) is None:
        raise InitializerError("image_ref is invalid")
    raw_profiles = document["profiles"]
    if type(raw_profiles) is not list or not raw_profiles or len(raw_profiles) > MAX_PROFILES:
        raise InitializerError("profiles is invalid")
    profiles = [validate_profile(item) for item in raw_profiles]
    profile_ids = [item["profile_id"] for item in profiles]
    profile_refs = [item["hermes_profile_ref"] for item in profiles]
    if len(set(profile_ids)) != len(profile_ids) or len(set(profile_refs)) != len(profile_refs):
        raise InitializerError("profiles contains duplicate identifiers")
    profiles.sort(key=lambda item: (str(item["profile_id"]), str(item["hermes_profile_ref"])))
    return {
        "bundle_version": 1,
        "tenant_id": tenant_id,
        "runtime_id": runtime_id,
        "generation": generation,
        "image_ref": image_ref,
        "profiles": profiles,
    }


def read_secret(secret_root: Path, requested_name: str) -> str:
    root = Path(os.path.abspath(secret_root))
    requested_path = Path(requested_name)
    requested = Path(os.path.abspath(requested_path))
    if (
        not requested_path.is_absolute()
        or requested.parent != root
        or not requested.name
        or "/" in requested.name
    ):
        raise InitializerError("Provider secret path is outside the fixed root")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        root_descriptor = os.open(root, directory_flags)
    except OSError as error:
        raise InitializerError("Provider secret root cannot be opened safely") from error
    descriptor = -1
    try:
        descriptor = os.open(
            requested.name,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=root_descriptor,
        )
        metadata = os.fstat(descriptor)
        mode = stat.S_IMODE(metadata.st_mode)
        if not stat.S_ISREG(metadata.st_mode):
            raise InitializerError("Provider secret is not a regular file")
        if metadata.st_uid != os.geteuid():
            raise InitializerError("Provider secret owner is invalid")
        if mode not in (0o400, 0o600):
            raise InitializerError("Provider secret mode is invalid")
        if metadata.st_size < 1 or metadata.st_size > MAX_SECRET_BYTES:
            raise InitializerError("Provider secret size is invalid")
        content = bytearray()
        while len(content) <= MAX_SECRET_BYTES:
            chunk = os.read(descriptor, min(4_096, MAX_SECRET_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        if not content or len(content) > MAX_SECRET_BYTES:
            raise InitializerError("Provider secret size is invalid")
        if b"\x00" in content or b"\r" in content or b"\n" in content:
            raise InitializerError("Provider secret contains invalid line data")
        try:
            return bytes(content).decode("utf-8")
        except UnicodeDecodeError as error:
            raise InitializerError("Provider secret encoding is invalid") from error
    except OSError as error:
        raise InitializerError("Provider secret cannot be opened safely") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(root_descriptor)


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def expected_manifest(bundle: dict[str, object]) -> dict[str, object]:
    profiles = list(bundle["profiles"])
    nonsecret_profiles = [{
        "profile_id": profile["profile_id"],
        "hermes_profile_ref": profile["hermes_profile_ref"],
        "description": profile["description"],
        "provider_base_url": profile["provider_base_url"],
        "model_id": profile["model_id"],
        "provider_secret_file": profile["provider_secret_file"],
    } for profile in profiles]
    canonical_fields = {
        "bundle_version": bundle["bundle_version"],
        "tenant_id": bundle["tenant_id"],
        "runtime_id": bundle["runtime_id"],
        "generation": bundle["generation"],
        "image_ref": bundle["image_ref"],
        "profiles": nonsecret_profiles,
    }
    return {
        "bundle_version": bundle["bundle_version"],
        "tenant_id": bundle["tenant_id"],
        "runtime_id": bundle["runtime_id"],
        "generation": bundle["generation"],
        "image_ref": bundle["image_ref"],
        "profiles": [{
            "profile_id": profile["profile_id"],
            "hermes_profile_ref": profile["hermes_profile_ref"],
        } for profile in profiles],
        "bundle_hash": "sha256:" + hashlib.sha256(canonical_json(canonical_fields)).hexdigest(),
    }


def existing_manifest_result(path: Path, expected: dict[str, object]) -> dict[str, object] | None:
    if not path.exists():
        return None
    existing = load_json(path)
    if type(existing) is not dict:
        raise InitializerError("Existing manifest is invalid")
    if existing == expected:
        return existing
    existing_generation = existing.get("generation")
    expected_generation = expected["generation"]
    if type(existing_generation) is not int or existing_generation >= expected_generation:
        raise InitializerError("Existing manifest conflicts with this generation")
    return None


def atomic_write(path: Path, payload: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / f".{path.name}.tmp.{os.getpid()}"
    descriptor = -1
    directory_descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            descriptor = -1
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(directory_descriptor)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if directory_descriptor >= 0:
            os.close(directory_descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def configure_profile(data_root: Path, profile: dict[str, object], provider_key: str) -> None:
    profile_ref = str(profile["hermes_profile_ref"])
    description = str(profile["description"])
    show = subprocess.run(
        ["hermes", "profile", "show", profile_ref],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if show.returncode == 0:
        subprocess.run(
            ["hermes", "profile", "describe", profile_ref, "--text", description],
            check=True,
            stdin=subprocess.DEVNULL,
        )
    else:
        subprocess.run(
            [
                "hermes", "profile", "create", profile_ref,
                "--no-skills", "--no-alias", "--description", description,
            ],
            check=True,
            stdin=subprocess.DEVNULL,
        )
    environment = (
        f"OPENAI_API_KEY={provider_key}\n"
        f"OPENAI_BASE_URL={profile['provider_base_url']}\n"
        f"LLM_MODEL={profile['model_id']}\n"
    ).encode("utf-8")
    atomic_write(data_root / "profiles" / profile_ref / ".env", environment, 0o600)


def initialize(bundle_path: Path, data_root: Path, manifest_path: Path, secret_root: Path) -> dict[str, object]:
    bundle = validate_bundle(load_json(bundle_path))
    manifest = expected_manifest(bundle)
    existing = existing_manifest_result(manifest_path, manifest)
    if existing is not None:
        return existing
    prepared = [(profile, read_secret(secret_root, str(profile["provider_secret_file"])))
                for profile in bundle["profiles"]]
    for profile, provider_key in prepared:
        configure_profile(data_root, profile, provider_key)
    atomic_write(manifest_path, canonical_json(manifest) + b"\n", 0o644)
    return manifest


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Initialize a Core-Agent Hermes runtime volume")
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE)
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--secret-root", type=Path, default=DEFAULT_SECRET_ROOT)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        manifest = initialize(
            arguments.bundle,
            arguments.data_root,
            arguments.manifest,
            arguments.secret_root,
        )
    except (InitializerError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 78
    except OSError:
        print("Initializer filesystem operation failed", file=sys.stderr)
        return 78
    print(canonical_json(manifest).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
