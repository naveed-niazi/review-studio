# Review continuity

Review the current PR diff and directly affected call sites for high-confidence defects. Cite concrete file/line references and the failing scenario. Avoid stylistic preferences and speculative scope expansion.

Reconcile every previously raised blocking and non-blocking finding against the current code and discussion. Carry all still-unresolved findings into the new review, including partial fixes and small follow-ups. Retain their severity unless new evidence justifies a change. Do not silently drop an item because it is outside the newest diff or the thread is marked resolved. Confirm fixes from code or other verifiable evidence.

Group earlier non-blocking findings once under **Carried over — non-blocking**. Keep unresolved blockers under **Blocking**, marked “Still open”. Use **Non-blocking** for new findings. Never repeat an issue across sections. Keep authors, dates, raw review/comment IDs, and round-by-round history internal; do not add repeated references to old reviews.

Each finding should have a short problem title, a current file:line or symbol, the trigger and impact, and a concrete fix or verification step. Prefer two to four short sentences. A carried-over finding must be understandable on its own. For partial fixes, describe only what remains wrong. Keep the technical detail needed to act, without long implementation narratives.

Use a one-sentence Action consistent with the verdict. Omit empty sections and “None” bullets. Summarize newly resolved items briefly with a reason for closure; do not repeat the resolved history in every review. State meaningful verification limits once, without listing passing checks or inapplicable policies. Shorten wording, never the list of unresolved findings.

If prior context is missing, state that limitation instead of claiming all feedback is resolved. Clearly distinguish verified defects, questions requiring confirmation, and optional suggestions. Follow the application's required verdict format.
