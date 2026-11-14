"""Result reporting for Python client scripts of the compatibility lab.

A script creates a ``Lab`` (client id, package version), runs scenarios with
``lab.scenario("id")`` as a decorator and calls ``lab.done()``. Every scenario prints one
machine-readable line (``@@COMPAT {json}``) that the launcher (run.mjs) collects into the matrix.

    pass: the function returned (a returned string is kept as the detail)
    fail: the function raised
    na:   the client cannot do this by design (raise ``NotApplicable("why")``)
    skip: the client could not run at all (missing package, ...)
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
import urllib.request

BASE_URL = os.environ.get("OAA_BASE_URL", "")
API_KEY = os.environ.get("OAA_API_KEY", "")
FIXTURE = os.environ.get("OAA_AGENT_FIXTURE", "agent/fixture")
SAMPLE = os.environ.get("OAA_AGENT_SAMPLE", "agent/sample")
NATIVE = os.environ.get("OAA_AGENT_NATIVE", "agent/native")
ACP = os.environ.get("OAA_AGENT_ACP", "agent/acp")


class NotApplicable(Exception):
    pass


def acp_script(*groups) -> str:
    """Prompt for the ACP stand-in agent: it calls the named caller tools (groups run one after another)."""
    return "Do the task.\nSCRIPT:" + json.dumps({"groups": [list(g) for g in groups]})


def describe(error: BaseException) -> str:
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    head = f"{type(error).__name__}" + (f" (HTTP {status})" if status else "")
    return f"{head}: {error}".replace("\n", " ")[:600]


def check(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(f"check failed: {message}")


def equal(actual: object, expected: object, what: str) -> None:
    if actual != expected:
        raise AssertionError(f"{what}: expected {expected!r}, got {actual!r}")


def gateway_json(path: str) -> object:
    """Plain GET to the gateway (for side-effect checks such as counting runs)."""
    req = urllib.request.Request(BASE_URL + path, headers={"authorization": f"Bearer {API_KEY}"})
    with urllib.request.urlopen(req, timeout=15) as response:  # noqa: S310 - loopback only
        return json.loads(response.read().decode("utf-8"))


def make_key(agents=("*",), scopes=("read", "invoke"), quota=None) -> str:
    """Creates a restricted caller key through the gateway's own key API and returns its token."""
    body = {"name": "compat-lab-scoped", "agents": list(agents), "scopes": list(scopes)}
    if quota:
        body["quota"] = quota
    req = urllib.request.Request(
        BASE_URL + "/v1/keys",
        data=json.dumps(body).encode("utf-8"),
        headers={"authorization": f"Bearer {API_KEY}", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as response:  # noqa: S310 - loopback only
        return json.loads(response.read().decode("utf-8"))["token"]


def cancel_active_runs() -> int:
    """Cancels runs still executing (a disconnected client does not cancel an accepted run)."""
    body = gateway_json("/v1/runs?limit=200")
    data = body.get("data", []) if isinstance(body, dict) else body
    active = [r["id"] for r in data if r.get("status") not in ("completed", "failed", "cancelled", "incomplete")]
    for run_id in active:
        req = urllib.request.Request(
            f"{BASE_URL}/v1/responses/{run_id}/cancel",
            data=b"{}",
            headers={"authorization": f"Bearer {API_KEY}", "content-type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=15).read()  # noqa: S310 - loopback only
    return len(active)


def snapshot_runs() -> set:
    """Ids of the newest runs; compare with `runs_created` (a plain count would saturate at the list limit)."""
    body = gateway_json("/v1/runs?limit=200")
    data = body.get("data", []) if isinstance(body, dict) else body
    return {r.get("id") for r in data}


def runs_created(before: set) -> int:
    return len(snapshot_runs() - before)


class Lab:
    def __init__(self, client: str, version: str = "") -> None:
        self.client = client
        self.version = version

    def record(self, scenario: str, status: str, detail: str = "", ms: int = 0) -> None:
        line = {
            "client": self.client,
            "version": self.version,
            "scenario": scenario,
            "status": status,
            "detail": detail[:600],
            "ms": ms,
        }
        sys.stdout.write("@@COMPAT " + json.dumps(line, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def scenario(self, scenario_id: str):
        def decorate(fn):
            started = time.monotonic()

            def ms() -> int:
                return int((time.monotonic() - started) * 1000)

            try:
                detail = fn()
                self.record(scenario_id, "pass", detail if isinstance(detail, str) else "", ms())
            except NotApplicable as error:
                self.record(scenario_id, "na", str(error), ms())
            except BaseException as error:  # noqa: BLE001 - every failure is a lab result
                if isinstance(error, KeyboardInterrupt):
                    raise
                tail = traceback.format_exc().strip().splitlines()[-3:]
                self.record(scenario_id, "fail", describe(error) + " | " + " / ".join(t.strip() for t in tail), ms())
            return fn

        return decorate

    def skip(self, reason: str) -> None:
        self.record("*", "skip", reason)

    def done(self) -> None:
        sys.stdout.write("@@COMPAT-DONE\n")
        sys.stdout.flush()
