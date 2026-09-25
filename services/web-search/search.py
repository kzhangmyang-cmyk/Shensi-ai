"""One bounded public search. No account state, tracing, browser profile or retries."""
import json
import sys

from ddgs import DDGS

request = json.loads(sys.stdin.read(4096))
query = request["query"]
if not isinstance(query, str) or not 2 <= len(query.strip()) <= 500:
    raise ValueError("invalid public query")
try:
    results = DDGS(timeout=12).text(query, region="cn-zh", backend="duckduckgo", max_results=5)
    print(json.dumps(results, ensure_ascii=False))
except Exception:
    # Never forward provider diagnostics/HTML or the query to application logs.
    print("public_search_unavailable", file=sys.stderr)
    sys.exit(1)
