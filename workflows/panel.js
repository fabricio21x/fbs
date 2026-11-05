export const meta = {
  name: 'panel',
  description: 'Review a document with independent seats in parallel, then a judge',
  phases: [{ title: 'Review' }, { title: 'Judge' }],
}

const FINDINGS = {
  type: 'object',
  required: ['seat', 'checked', 'findings'],
  properties: {
    seat: { type: 'string' },
    checked: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'claim', 'evidence', 'suggestion', 'principle'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
          principle: { type: ['string', 'null'] },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['decisions', 'changes', 'summary', 'uniform'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'seat', 'accepted', 'reason'],
        properties: {
          id: { type: 'string' },
          seat: { type: 'string' },
          accepted: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    changes: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    uniform: { type: 'boolean' },
  },
}

if (!args || typeof args.doc !== 'string' || !Array.isArray(args.seats) || args.seats.length === 0) {
  throw new Error('panel needs args = { doc: string, inputs: string[], seats: string[], model?: string }')
}

const inputs = Array.isArray(args.inputs) ? args.inputs : []
// args.model (e.g. 'fable') replaces Opus for the judge and the Opus seats; the Sonnet seats keep their model.
const OPUS_AGENTS = ['fbs:seats:pessimist', 'fbs:seats:security', 'fbs:seats:staff-engineer', 'fbs:judge']
const MODELS = ['opus', 'fable', 'sonnet']
const model = typeof args.model === 'string' ? args.model.trim().toLowerCase() : null
if (model !== null && !MODELS.includes(model)) throw new Error(`panel: unknown model '${args.model}', use one of ${MODELS.join(', ')}`)
const modelFor = name => (model !== null && OPUS_AGENTS.includes(name) ? { model } : {})
const inputLines = inputs.length > 0 ? inputs.map(path => `- ${path}`).join('\n') : '- (none)'
const reading = `Document under review: ${args.doc}\n\nInputs to read before reviewing (skip any that don't exist):\n${inputLines}`

phase('Review')
const results = await parallel(
  args.seats.map(seat => () =>
    agent(`${reading}\n\nReview the document through your lens and return your findings.`, {
      agentType: seat,
      ...modelFor(seat),
      phase: 'Review',
      label: seat,
      schema: FINDINGS,
    }),
  ),
)

const findings = []
const missing = []
results.forEach((result, i) => {
  const seat = args.seats[i].split(':').pop()
  if (result === null) {
    log(`${seat} returned no findings (failed or stopped)`)
    missing.push(seat)
  } else {
    findings.push({ ...result, seat })
  }
})

if (findings.length === 0) return { findings: [], verdict: null, missing }

phase('Judge')
// parallel() turns a failed judge into null, so the seats' findings still come back.
const [verdict] = await parallel([
  () =>
    agent(
      `${reading}\n\nThe seats' findings, as JSON:\n${JSON.stringify(findings, null, 2)}\n\nDecide every finding and return your verdict.`,
      { agentType: 'fbs:judge', ...modelFor('fbs:judge'), phase: 'Judge', label: 'judge', schema: VERDICT },
    ),
])
if (verdict === null) log('judge returned no verdict (failed or stopped)')

return { findings, verdict, missing }
