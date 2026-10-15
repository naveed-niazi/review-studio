export const checkDescriptions = {
  tests:
    'Tests accompany feature changes: for meaningful new or changed behavior, verify that appropriate tests travel with the change. Flag absent coverage for critical changed paths with a concrete rationale. Do not demand tests for trivial text or styling changes. Do not claim tests were executed.',
  analytics:
    'Analytics accompany feature changes: inspect existing analytics conventions and verify that new or redesigned user flows retain or add their required events. Identify missing or broken tracking with the relevant established requirement or existing pattern. Do not invent event requirements unsupported by this repository.',
  security:
    'Security checks: trace changed authentication, authorization, input validation, secret handling, and trust boundaries. Report high-confidence security regressions with a concrete scenario.',
  compatibility:
    'Backward compatibility: inspect affected public interfaces, schema changes, migrations, serialized formats and existing callers. Flag breaking changes lacking an explicit migration or compatibility plan.',
};
export function renderChecks(checks = {}) {
  return (
    Object.entries(checkDescriptions)
      .filter(([key]) => checks[key])
      .map(([, text]) => `- ${text}`)
      .join('\n') || 'No additional checklist enabled. Apply the custom review instructions.'
  );
}
export function validateChecks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected review check settings.');
  for (const [k, v] of Object.entries(value))
    if (!(k in checkDescriptions) || typeof v !== 'boolean')
      throw new Error('Invalid review check.');
  return value;
}
