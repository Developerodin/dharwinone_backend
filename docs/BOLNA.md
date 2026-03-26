# Bolna voice agents — start here

This is the **main index** for Bolna integration: two agents (job verification vs candidate verification), webhooks, env vars, and links to detailed guides.

## Two agents

| Env var | Role |
|---------|------|
| `BOLNA_AGENT_ID` | Outbound calls to **recruiters** (e.g. job posted / job verification). |
| `BOLNA_CANDIDATE_AGENT_ID` | Outbound calls to **candidates** after apply / from ATS. |

**Fallback:** If `BOLNA_CANDIDATE_AGENT_ID` is unset, the backend uses `BOLNA_AGENT_ID` for candidate flows (see `src/config/config.js` → `bolna.candidateAgentId`).

## Environment variables (templates only)

Put real values in `.env` — **do not commit secrets.**

```env
BOLNA_API_KEY=your_bolna_api_key
BOLNA_API_BASE=https://api.bolna.ai
BOLNA_FROM_PHONE_NUMBER=+10000000000
BOLNA_AGENT_ID=your_job_verification_agent_uuid
BOLNA_CANDIDATE_AGENT_ID=your_candidate_verification_agent_uuid
```

Optional: other Bolna-related vars as documented in `.env.example`.

## Webhooks (required for transcripts / status sync)

Use **two different** URLs in the Bolna dashboard:

- Job agent → `https://<your-backend>/api/v1/webhooks/bolna-calls`
- Candidate agent → `https://<your-backend>/api/v1/webhooks/bolna-candidate-calls`

Full walkthrough, curl examples, and DB notes: **[SEPARATE_WEBHOOKS.md](./SEPARATE_WEBHOOKS.md)**.

For local dev, tunnel your backend (e.g. ngrok) and substitute your tunnel host wherever that doc uses `YOUR_NGROK_HOST`.

## Setup checklist

1. Create or confirm both agents in [Bolna dashboard](https://app.bolna.ai).
2. Paste dashboard fields from **[BOLNA_QUICK_SETUP.md](./BOLNA_QUICK_SETUP.md)** (candidate agent) and prompts from the prompt docs below as needed.
3. Set webhooks per **[SEPARATE_WEBHOOKS.md](./SEPARATE_WEBHOOKS.md)**.
4. Fill `.env`, restart the backend, run a test application or job post and watch logs.

## Detailed docs (by topic)

| Doc | Use for |
|-----|---------|
| [BOLNA_QUICK_SETUP.md](./BOLNA_QUICK_SETUP.md) | Copy-paste Bolna dashboard sections (name, goal, script blocks, voicemail). |
| [BOLNA_APPLICATION_CALLS_SETUP.md](./BOLNA_APPLICATION_CALLS_SETUP.md) | Scheduler flow, env, troubleshooting for post-application calls. |
| [BOLNA_AGENT_VARIABLES.md](./BOLNA_AGENT_VARIABLES.md) | `{{variable}}` reference for prompts. |
| [BOLNA_AGENT_COMPLETE_PROMPT.md](./BOLNA_AGENT_COMPLETE_PROMPT.md) | Full system prompt for the job/recruiter-style agent. |
| [BOLNA_CANDIDATE_AGENT_PROMPT.md](./BOLNA_CANDIDATE_AGENT_PROMPT.md) | System prompt for `BOLNA_CANDIDATE_AGENT_ID`. |
| [SEPARATE_WEBHOOKS.md](./SEPARATE_WEBHOOKS.md) | Webhook URLs, testing, monitoring. |
| [CANDIDATE_CALL_FROM_APPLICANTS.md](./CANDIDATE_CALL_FROM_APPLICANTS.md) | ATS UI: bulk candidate calls from applicants tab. |

## Troubleshooting (short)

- **No call after apply:** Check `BOLNA_CANDIDATE_AGENT_ID`, phone on candidate, and logs for Bolna errors.
- **Webhook not updating records:** Confirm each agent’s webhook URL matches **SEPARATE_WEBHOOKS** (candidate URL must not point at the job endpoint).
- **Wrong agent voice/script:** Verify the agent UUID in `.env` matches the dashboard agent you edited.

## External links

- [Bolna docs](https://docs.bolna.ai)
- [Bolna app](https://app.bolna.ai)
