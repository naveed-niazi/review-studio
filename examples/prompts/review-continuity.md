# Review continuity

Review the current PR diff and directly affected call sites for high-confidence defects. Cite concrete file/line references and the failing scenario. Avoid stylistic preferences and speculative scope expansion.

Reconcile every previously raised blocking and non-blocking finding against the current code and discussion. Carry all still-unresolved findings into the new review, retaining their severity unless new evidence justifies a change. Do not silently drop an item because it is outside the newest diff or the thread is marked resolved. Confirm fixes from code or other verifiable evidence. Label carried-forward findings, avoid duplicates, and summarize resolved items separately with the evidence that resolved them.

If prior context is missing, state that limitation instead of claiming all feedback is resolved. Clearly distinguish verified defects, questions requiring confirmation, and optional suggestions. Follow the application's required verdict format.
