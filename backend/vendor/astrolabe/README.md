# Astrolabe pure engines

Source: https://github.com/kzhangmyang-cmyk/Astrolabe-Decision-Simulator

Pinned source commit: `b994ce16368e604313db878161a0617b99d833a8`.
The project owner requested reuse of their source. The upstream tree does not
contain a repository LICENSE; this copy does not assign it an open-source license.

## Included boundary

`decision_os_backend/services/decision_engine` and `simulation_engine` retain
the original rule assessment and Founder → Market → Operations → Finance → Judge
monthly algorithms. `schemas/{common,assessment,simulation,planner}.py` and
`models/enums.py` contain their plain schema and enum dependencies.

The application, ORM, database migrations, HTTP routes, old frontend and demo
examples are not included. Top-level package initializers are empty to avoid
server initialization. `decision_engine/__init__.py` removes the optional demo
example exports; the original engine implementations are unchanged.

This is a source integration in progress, not an enabled startup-mode endpoint.
Assessment confidence is a heuristic score, not a calibrated success probability.
The startup generator randomizes company starting conditions; it must not replace
the shared baseline of the separate operating-company comparison engine.

## Runtime and checks

Python 3.11+ and Pydantic 2 are required. The current development interpreter
already provides Pydantic 2.13.4. Python packaging for the backend distribution
and third-party license notices must be completed before enabling this module
in a packaged or cloud runtime. Do not install dependencies during user requests.

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 services/media-crawler/.venv/bin/python backend/vendor/astrolabe/test_pure_engines.py
```

These synthetic checks exercise real pure engines without database, network,
model calls, or existing customer records. Saved startup reports must retain
engine commit, seed, inputs and full monthly results when the API is connected.
