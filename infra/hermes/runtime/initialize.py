#!/usr/bin/env python3
"""Fixed, no-network Hermes Profile initializer owned by the product image."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit


DEFAULT_BUNDLE = Path("/run/core-agent/bootstrap/bundle.json")
DEFAULT_DATA_ROOT = Path("/opt/data")
DEFAULT_MANIFEST = Path("/opt/data/.core-agent/manifest.json")
DEFAULT_SECRET_ROOT = Path("/run/core-agent/secrets")
APPROVED_MODEL_ID = "cywx/gpt-5.6-sol"
MAX_PROFILES = 64
MAX_SECRET_BYTES = 16_384
MAX_MANIFEST_BYTES = 65_536
MANIFEST_MODE = 0o644
PRIVATE_DIRECTORY_MODE = 0o700
LOCK_MODE = 0o600
MANIFEST_NAME = "manifest.json"
LOCK_NAME = "initialize.lock"
INGRESS_SECRET_NAME = "hermes_ingress"
OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
PROFILE_REF = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
IMAGE_REF = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*"
    r"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?"
    r"@sha256:[a-f0-9]{64}$"
)
BUNDLE_HASH = re.compile(r"^sha256:[a-f0-9]{64}$")
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


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
            raise InitializerError("JSON contains a duplicate property")
        result[key] = value
    return result


def parse_json(payload: bytes, label: str) -> object:
    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise InitializerError(f"{label} JSON is invalid") from error


def load_bundle(path: Path) -> object:
    try:
        with path.open("rb") as stream:
            payload = stream.read(1_048_577)
    except OSError as error:
        raise InitializerError("Bundle JSON is unavailable") from error
    if not payload or len(payload) > 1_048_576:
        raise InitializerError("Bundle JSON is invalid")
    return parse_json(payload, "Bundle")


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
        or parsed.query
        or parsed.fragment
        or "\r" in url
        or "\n" in url
    ):
        raise InitializerError("provider_base_url is invalid")
    return url


def hermes_provider_base_url(value: str) -> str:
    parsed = urlsplit(value)
    path = parsed.path.rstrip("/")
    completion_suffix = "/chat/completions"
    if path.endswith(completion_suffix):
        path = path[:-len(completion_suffix)].rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def validate_profile(value: object) -> dict[str, object]:
    profile = closed_object(value, {
        "profile_id",
        "hermes_profile_ref",
        "description",
        "provider_base_url",
        "model_id",
        "provider_secret_file",
        "policy_runtime_secret_file",
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
    policy_runtime_secret_file = require_string(
        profile["policy_runtime_secret_file"], "policy_runtime_secret_file", 4_096
    )
    return {
        "profile_id": profile_id,
        "hermes_profile_ref": profile_ref,
        "description": description,
        "provider_base_url": provider_base_url,
        "model_id": model_id,
        "provider_secret_file": secret_file,
        "policy_runtime_secret_file": policy_runtime_secret_file,
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
    if type(document["bundle_version"]) is not int or document["bundle_version"] != 1:
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
        "policy_runtime_secret_file": profile["policy_runtime_secret_file"],
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


def validate_manifest(value: object) -> dict[str, object]:
    manifest = closed_object(value, {
        "bundle_version",
        "tenant_id",
        "runtime_id",
        "generation",
        "image_ref",
        "profiles",
        "bundle_hash",
    }, "Manifest")
    if type(manifest["bundle_version"]) is not int or manifest["bundle_version"] != 1:
        raise InitializerError("Existing manifest is invalid")
    tenant_id = require_id(manifest["tenant_id"], "manifest tenant_id")
    runtime_id = require_id(manifest["runtime_id"], "manifest runtime_id")
    generation = manifest["generation"]
    if type(generation) is not int or generation < 1 or generation > 2_147_483_647:
        raise InitializerError("Existing manifest is invalid")
    image_ref = require_string(manifest["image_ref"], "manifest image_ref", 512)
    if IMAGE_REF.fullmatch(image_ref) is None:
        raise InitializerError("Existing manifest is invalid")
    bundle_hash = require_string(manifest["bundle_hash"], "manifest bundle_hash", 71)
    if BUNDLE_HASH.fullmatch(bundle_hash) is None:
        raise InitializerError("Existing manifest is invalid")
    raw_profiles = manifest["profiles"]
    if type(raw_profiles) is not list or not raw_profiles or len(raw_profiles) > MAX_PROFILES:
        raise InitializerError("Existing manifest is invalid")
    profiles: list[dict[str, str]] = []
    for value_profile in raw_profiles:
        profile = closed_object(value_profile, {"profile_id", "hermes_profile_ref"}, "Manifest Profile")
        profile_id = require_id(profile["profile_id"], "manifest profile_id")
        profile_ref = require_string(profile["hermes_profile_ref"], "manifest hermes_profile_ref", 63)
        if PROFILE_REF.fullmatch(profile_ref) is None:
            raise InitializerError("Existing manifest is invalid")
        profiles.append({"profile_id": profile_id, "hermes_profile_ref": profile_ref})
    if profiles != sorted(profiles, key=lambda item: (item["profile_id"], item["hermes_profile_ref"])):
        raise InitializerError("Existing manifest is invalid")
    if len({item["profile_id"] for item in profiles}) != len(profiles):
        raise InitializerError("Existing manifest is invalid")
    if len({item["hermes_profile_ref"] for item in profiles}) != len(profiles):
        raise InitializerError("Existing manifest is invalid")
    return {
        "bundle_version": 1,
        "tenant_id": tenant_id,
        "runtime_id": runtime_id,
        "generation": generation,
        "image_ref": image_ref,
        "profiles": profiles,
        "bundle_hash": bundle_hash,
    }


def file_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def validate_directory(metadata: os.stat_result, label: str, exact_mode: int | None = None,
                       allow_sticky_volume_root: bool = False) -> None:
    mode = stat.S_IMODE(metadata.st_mode)
    owned_private = metadata.st_uid == os.geteuid() and (exact_mode is not None or not mode & 0o022)
    sticky_volume_root = allow_sticky_volume_root and mode == 0o1777 and metadata.st_uid in (0, os.geteuid())
    if not stat.S_ISDIR(metadata.st_mode) or not (owned_private or sticky_volume_root):
        raise InitializerError(f"{label} directory is unsafe")
    if exact_mode is not None:
        if mode != exact_mode:
            raise InitializerError(f"{label} directory mode is unsafe")
    elif not sticky_volume_root and mode & 0o022:
        raise InitializerError(f"{label} directory mode is unsafe")


def open_root_directory(path: Path, label: str, exact_mode: int | None = None,
                        allow_sticky_volume_root: bool = False) -> tuple[int, tuple[int, int]]:
    normalized = Path(os.path.abspath(path))
    if not path.is_absolute():
        raise InitializerError(f"{label} directory path is invalid")
    try:
        before = os.stat(normalized, follow_symlinks=False)
        descriptor = os.open(normalized, DIRECTORY_FLAGS)
    except OSError as error:
        raise InitializerError(f"{label} directory cannot be opened safely") from error
    try:
        metadata = os.fstat(descriptor)
        validate_directory(metadata, label, exact_mode, allow_sticky_volume_root)
        if (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise InitializerError(f"{label} directory changed while opening")
        return descriptor, (metadata.st_dev, metadata.st_ino)
    except BaseException:
        os.close(descriptor)
        raise


def assert_root_directory(path: Path, descriptor: int, identity: tuple[int, int], label: str,
                          exact_mode: int | None = None, allow_sticky_volume_root: bool = False) -> None:
    try:
        metadata = os.fstat(descriptor)
        named = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise InitializerError(f"{label} directory changed") from error
    validate_directory(metadata, label, exact_mode, allow_sticky_volume_root)
    if identity != (metadata.st_dev, metadata.st_ino) or identity != (named.st_dev, named.st_ino):
        raise InitializerError(f"{label} directory changed")


def assert_named_directory(parent_descriptor: int, name: str, descriptor: int, label: str) -> None:
    try:
        metadata = os.fstat(descriptor)
        named = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except OSError as error:
        raise InitializerError(f"{label} directory changed") from error
    validate_directory(metadata, label, PRIVATE_DIRECTORY_MODE)
    if (metadata.st_dev, metadata.st_ino) != (named.st_dev, named.st_ino):
        raise InitializerError(f"{label} directory changed")


def open_or_create_directory(parent_descriptor: int, name: str, label: str) -> int:
    try:
        os.mkdir(name, PRIVATE_DIRECTORY_MODE, dir_fd=parent_descriptor)
    except FileExistsError:
        pass
    except OSError as error:
        raise InitializerError(f"{label} directory cannot be created safely") from error
    descriptor = -1
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_descriptor)
        assert_named_directory(parent_descriptor, name, descriptor, label)
        return descriptor
    except OSError as error:
        raise InitializerError(f"{label} directory cannot be opened safely") from error
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        raise


def read_secret(root_descriptor: int, root_path: Path, root_identity: tuple[int, int],
                requested_name: str) -> str:
    requested_path = Path(requested_name)
    requested = Path(os.path.abspath(requested_path))
    normalized_root = Path(os.path.abspath(root_path))
    if (
        not requested_path.is_absolute()
        or requested.parent != normalized_root
        or not requested.name
        or "/" in requested.name
    ):
        raise InitializerError("Provider secret path is outside the fixed root")
    descriptor = -1
    try:
        descriptor = os.open(requested.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_descriptor)
        before = os.fstat(descriptor)
        mode = stat.S_IMODE(before.st_mode)
        if not stat.S_ISREG(before.st_mode):
            raise InitializerError("Provider secret is not a regular file")
        if before.st_uid != os.geteuid():
            raise InitializerError("Provider secret owner is invalid")
        if mode not in (0o400, 0o600):
            raise InitializerError("Provider secret mode is invalid")
        if before.st_size < 1 or before.st_size > MAX_SECRET_BYTES:
            raise InitializerError("Provider secret size is invalid")
        content = bytearray()
        while len(content) <= MAX_SECRET_BYTES:
            chunk = os.read(descriptor, min(4_096, MAX_SECRET_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        after = os.fstat(descriptor)
        if file_identity(before) != file_identity(after) or len(content) != before.st_size:
            raise InitializerError("Provider secret changed while reading")
        assert_root_directory(root_path, root_descriptor, root_identity, "Provider secret root")
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


def validate_regular_file(metadata: os.stat_result, label: str, mode: int, maximum: int) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != mode
        or metadata.st_size < 1
        or metadata.st_size > maximum
    ):
        raise InitializerError(f"{label} file is unsafe")


def read_manifest(core_descriptor: int) -> dict[str, object] | None:
    try:
        descriptor = os.open(MANIFEST_NAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=core_descriptor)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise InitializerError("Existing manifest cannot be opened safely") from error
    try:
        before = os.fstat(descriptor)
        validate_regular_file(before, "Existing manifest", MANIFEST_MODE, MAX_MANIFEST_BYTES)
        payload = bytearray()
        while len(payload) <= MAX_MANIFEST_BYTES:
            chunk = os.read(descriptor, min(4_096, MAX_MANIFEST_BYTES + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        if file_identity(before) != file_identity(after) or len(payload) != before.st_size:
            raise InitializerError("Existing manifest changed while reading")
        manifest = validate_manifest(parse_json(bytes(payload), "Existing manifest"))
        if bytes(payload) != canonical_json(manifest) + b"\n":
            raise InitializerError("Existing manifest is not canonical")
        return manifest
    finally:
        os.close(descriptor)


def open_lock(core_descriptor: int) -> int:
    try:
        descriptor = os.open(
            LOCK_NAME,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            LOCK_MODE,
            dir_fd=core_descriptor,
        )
    except OSError as error:
        raise InitializerError("Initializer lock cannot be opened safely") from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != LOCK_MODE
        ):
            raise InitializerError("Initializer lock file is unsafe")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        named = os.stat(LOCK_NAME, dir_fd=core_descriptor, follow_symlinks=False)
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino) != (named.st_dev, named.st_ino):
            raise InitializerError("Initializer lock file changed")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def atomic_write(core_descriptor: int, name: str, payload: bytes, mode: int) -> None:
    temporary = f".{name}.tmp.{os.getpid()}"
    descriptor = -1
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
            dir_fd=core_descriptor,
        )
        os.fchmod(descriptor, mode)
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written < 1:
                raise InitializerError("Temporary output write failed")
            offset += written
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        validate_regular_file(metadata, "Temporary output", mode, max(len(payload), 1))
        os.close(descriptor)
        descriptor = -1
        os.rename(
            temporary,
            name,
            src_dir_fd=core_descriptor,
            dst_dir_fd=core_descriptor,
        )
        published = os.stat(name, dir_fd=core_descriptor, follow_symlinks=False)
        if (published.st_dev, published.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise InitializerError("Published output changed")
        os.fsync(core_descriptor)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=core_descriptor)
        except FileNotFoundError:
            pass


def configure_profile(
    profiles_descriptor: int,
    profile: dict[str, object],
    provider_key: str,
    policy_runtime_token: str,
    ingress_key: str,
) -> None:
    profile_ref = str(profile["hermes_profile_ref"])
    description = str(profile["description"])
    profile_descriptor = open_or_create_directory(profiles_descriptor, profile_ref, "Profile")
    try:
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
        assert_named_directory(profiles_descriptor, profile_ref, profile_descriptor, "Profile")
        model_id = str(profile["model_id"])
        provider_name = "core-agent-managed"
        environment = (
            f"CORE_AGENT_PROVIDER_API_KEY={provider_key}\n"
            f"API_SERVER_KEY={ingress_key}\n"
            f"CORE_AGENT_POLICY_RUNTIME_TOKEN={policy_runtime_token}\n"
        ).encode("utf-8")
        configuration = canonical_json({
            "model": {
                "default": model_id,
                "provider": provider_name,
            },
            "providers": {
                provider_name: {
                    "base_url": hermes_provider_base_url(str(profile["provider_base_url"])),
                    "default_model": model_id,
                    "key_env": "CORE_AGENT_PROVIDER_API_KEY",
                    "transport": "chat_completions",
                },
            },
            "plugins": {
                "enabled": ["core-agent-policy"],
            },
            "mcp_servers": {
                "core_agent_gateway": {
                    "url": "http://policy-gateway-ingress:8787/mcp",
                    "headers": {
                        "Authorization": "Bearer ${CORE_AGENT_POLICY_RUNTIME_TOKEN}",
                    },
                    "strict_redirect_headers": True,
                    "skip_preflight": True,
                    "connect_timeout": 5,
                    "timeout": 30,
                },
            },
        }) + b"\n"
        atomic_write(profile_descriptor, ".env", environment, 0o600)
        atomic_write(profile_descriptor, "config.yaml", configuration, 0o600)
    finally:
        os.close(profile_descriptor)


def remove_profile_directory(profiles_descriptor: int, profile_ref: str) -> None:
    try:
        descriptor = os.open(profile_ref, DIRECTORY_FLAGS, dir_fd=profiles_descriptor)
    except FileNotFoundError:
        return
    except OSError as error:
        raise InitializerError("Removed Profile directory cannot be opened safely") from error
    try:
        assert_named_directory(profiles_descriptor, profile_ref, descriptor, "Removed Profile")
        for filename, label in (
            (".env", "Removed Profile environment"),
            ("config.yaml", "Removed Profile configuration"),
        ):
            try:
                metadata = os.stat(filename, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                metadata = None
            if metadata is not None:
                validate_regular_file(metadata, label, 0o600, MAX_SECRET_BYTES + 4_096)
                os.unlink(filename, dir_fd=descriptor)
                os.fsync(descriptor)
        if os.listdir(descriptor):
            raise InitializerError("Removed Profile directory is not empty")
        assert_named_directory(profiles_descriptor, profile_ref, descriptor, "Removed Profile")
    finally:
        os.close(descriptor)
    os.rmdir(profile_ref, dir_fd=profiles_descriptor)
    os.fsync(profiles_descriptor)


def initialize(bundle_path: Path, data_root: Path, manifest_path: Path, secret_root: Path) -> dict[str, object]:
    bundle = validate_bundle(load_bundle(bundle_path))
    manifest = expected_manifest(bundle)
    normalized_data_root = Path(os.path.abspath(data_root))
    expected_manifest_path = normalized_data_root / ".core-agent" / MANIFEST_NAME
    if not manifest_path.is_absolute() or Path(os.path.abspath(manifest_path)) != expected_manifest_path:
        raise InitializerError("Manifest path is outside the fixed data root")

    data_descriptor, data_identity = open_root_directory(
        data_root, "Data root", allow_sticky_volume_root=True
    )
    core_descriptor = -1
    lock_descriptor = -1
    profiles_descriptor = -1
    secret_descriptor = -1
    try:
        core_descriptor = open_or_create_directory(data_descriptor, ".core-agent", "Core metadata")
        lock_descriptor = open_lock(core_descriptor)
        assert_root_directory(
            data_root, data_descriptor, data_identity, "Data root", allow_sticky_volume_root=True
        )
        assert_named_directory(data_descriptor, ".core-agent", core_descriptor, "Core metadata")

        existing = read_manifest(core_descriptor)
        if existing == manifest:
            return existing
        if existing is not None:
            if (
                existing["bundle_version"] != manifest["bundle_version"]
                or existing["tenant_id"] != manifest["tenant_id"]
                or existing["runtime_id"] != manifest["runtime_id"]
                or int(existing["generation"]) >= int(manifest["generation"])
            ):
                raise InitializerError("Existing manifest conflicts with this generation")

        profiles_descriptor = open_or_create_directory(data_descriptor, "profiles", "Profiles")
        secret_descriptor, secret_identity = open_root_directory(secret_root, "Provider secret root")
        ingress_key = read_secret(
            secret_descriptor,
            secret_root,
            secret_identity,
            str(Path(os.path.abspath(secret_root)) / INGRESS_SECRET_NAME),
        )
        prepared = [
            (profile, read_secret(
                secret_descriptor,
                secret_root,
                secret_identity,
                str(profile["provider_secret_file"]),
            ), read_secret(
                secret_descriptor,
                secret_root,
                secret_identity,
                str(profile["policy_runtime_secret_file"]),
            ))
            for profile in bundle["profiles"]
        ]
        assert_root_directory(secret_root, secret_descriptor, secret_identity, "Provider secret root")

        for profile, provider_key, policy_runtime_token in prepared:
            configure_profile(
                profiles_descriptor, profile, provider_key, policy_runtime_token, ingress_key
            )

        current_refs = {str(profile["hermes_profile_ref"]) for profile in bundle["profiles"]}
        previous_refs = set()
        if existing is not None:
            previous_refs = {str(profile["hermes_profile_ref"]) for profile in existing["profiles"]}
        for removed_ref in sorted(previous_refs - current_refs):
            subprocess.run(
                ["hermes", "profile", "delete", removed_ref, "--yes"],
                check=True,
                stdin=subprocess.DEVNULL,
            )
            remove_profile_directory(profiles_descriptor, removed_ref)

        assert_root_directory(
            data_root, data_descriptor, data_identity, "Data root", allow_sticky_volume_root=True
        )
        assert_named_directory(data_descriptor, ".core-agent", core_descriptor, "Core metadata")
        assert_named_directory(data_descriptor, "profiles", profiles_descriptor, "Profiles")
        atomic_write(core_descriptor, MANIFEST_NAME, canonical_json(manifest) + b"\n", MANIFEST_MODE)
        return manifest
    finally:
        if secret_descriptor >= 0:
            os.close(secret_descriptor)
        if profiles_descriptor >= 0:
            os.close(profiles_descriptor)
        if lock_descriptor >= 0:
            os.close(lock_descriptor)
        if core_descriptor >= 0:
            os.close(core_descriptor)
        os.close(data_descriptor)


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
