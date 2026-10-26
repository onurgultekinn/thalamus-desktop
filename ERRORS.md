# Error codes

Every user-visible error in Thalamus shows a stable code. The code never
changes meaning between releases, so the same code always points to the
same condition. Codes follow HTTP status semantics.

| Code | Name | Condition | What to do |
|---|---|---|---|
| 499 | Client Closed Request | you pressed Stop | nothing — the request was cancelled |
| 408 | Request Timeout | no response within 180 s | retry; check your connection |
| 401 | Unauthorized | no API key set, or the provider rejected the key | open Settings → Providers and check the key |
| 402 | Payment Required | provider billing/balance failure | top up or check the provider dashboard |
| 403 | Forbidden | provider access denied (plan or key scope) | check the provider plan/key permissions |
| 404 | Not Found | model or endpoint unknown to the provider | pick another model in Settings |
| 415 | Unsupported Media Type | the file is not valid UTF-8 text | open it with a text editor or choose another file |
| 429 | Too Many Requests | provider rate or usage limit | wait and retry, or switch model |
| 413 | Payload Too Large | the agent tried to read more in one step than allowed | re-run the request; it will read in smaller pieces |
| 508 | Loop Detected | the agent hit its tool-step limit before finishing | re-run, or narrow the request to a specific file or question |
| 5xx | Provider Server Error | passthrough of the provider's own 500/502/... | retry later; nothing wrong on your side |
| 503 | Service Unavailable | the local engine is unreachable | restart the app; check the backend log |
| 507 | Insufficient Storage | localStorage quota exceeded | clear old chats or exports |
| 500 | Internal Error | unexpected/unmapped failure | report it with the code and the detail line |

When reporting a bug, include the code and the dim detail line shown under
the error. Logs stay on your machine; nothing is sent automatically.
