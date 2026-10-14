# Built-in public search

The Backend uses this bounded DDGS process when the current actor has no enabled
search connection. Existing configured providers take precedence. Only the
planner's public query crosses stdin; no files, account credentials, chat history
or browser profiles are loaded. The process has a 20-second outer deadline,
request cancellation and no application retry. Failures are not empty successes.

Install once in each source deployment before starting its Backend:

```sh
uv venv --python 3.12 services/web-search/.venv
uv pip sync --python services/web-search/.venv/bin/python services/web-search/requirements.lock
```

`SHENSI_SEARCH_PYTHON` can select a preinstalled Python environment containing the
locked dependencies. The default is this directory's `.venv/bin/python`.
Dependencies are not downloaded during a chat. Packaged and container deployments
must install this environment; the source integration alone does not provision it.

## Upstream comparison

- [Local Deep Researcher](https://github.com/langchain-ai/local-deep-researcher)
  is MIT. Its `utils.py` uses `DDGS.text` and maps `title/href/body`; this integration
  reuses that dependency/API, not LangGraph, tracing or the full research loop.
- [DDGS](https://github.com/deedy5/ddgs) is MIT; version 9.16.0 is pinned. Its three
  direct dependencies are click, primp and lxml. Upstream's default multi-engine
  mode is not used: the backend is explicitly DuckDuckGo.
- [SearXNG](https://github.com/searxng/searxng) is AGPL-3.0 and independently
  deployable, but adds an HTTP service/configuration lifecycle. It is not needed
  for this initial local path; no third-party public instance receives queries.

The search result is an index snippet, not verification of every claim in a
page. The normal citation validator and source snapshot remain authoritative.
Search engines may rate-limit or be unreachable; those failures remain visible.
