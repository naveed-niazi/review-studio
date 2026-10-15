# Experiment and analytics review

Trace the experiment from eligibility and assignment through exposure and outcome events, using the repository's actual analytics SDK, event definitions, and experiment configuration as evidence.

Check stable assignment, correct control/variant handling, identity consistency across anonymous and authenticated users, targeting, environment separation, and behavior when flags fail or are unavailable. Verify exposure is recorded when the user actually encounters the treatment, at the intended analysis unit, without accidental repeated exposure from rerenders or retries.

Trace outcome events, property names/types, timestamps, deduplication, and identity linkage. Check that outcomes can be attributed to the correct experiment/variant and that missing events, duplicate events, or consent behavior cannot silently bias results. Verify feature-flag evaluation events are not confused with actual treatment exposure. For PostHog integrations, compare the installed SDK behavior and repository configuration with the intended experiment measurement approach; do not invent project-specific event names or assume a live dashboard configuration you cannot inspect.

Check meaningful tests for eligibility, variant assignment, exposure, conversion, disabled flags, failures, and rollback. Report concrete defects with file/line references and explain their effect on measurement. Separate verified code findings from dashboard/settings checks requiring human confirmation. Follow the application's required verdict format.
