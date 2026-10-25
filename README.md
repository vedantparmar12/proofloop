<div align="center">

# ProofLoop

**Better-fit jobs. Evidence-backed drafts. You make the final call.**

A local career copilot that turns your CV into a focused job search,<br>
reviewable application materials, and a human-controlled application workflow.

**Bun** · **HTMX** · **SQLite** · **Gemini CLI** · **Chrome**

[Quick start](#quick-start) · [How it works](#how-it-works) · [Dashboard guide](#dashboard-guide) · [CLI](#cli-reference) · [Privacy](#privacy-and-data)

</div>

---

> [!IMPORTANT]
> ProofLoop assists; it does not apply on your behalf. Review every generated claim, approve the documents yourself, and complete login, CAPTCHA, screening questions, and final submission manually.

## What you get

| Capability | What it does |
| --- | --- |
| **One master CV** | Extract text from PDF, DOCX, TXT, or Markdown, or paste your career history directly. |
| **A focused job inbox** | Scan public Greenhouse/Lever company boards or search LinkedIn/Indeed through optional JobSpy, then rank openings against your CV and preferences. |
| **Honest application tracking** | See confirmed submissions, distinct companies applied to, pending approvals, drafts, and a timestamped local activity log. |
| **Post-submission outcomes** | Record replies you actually receive, then review a cumulative applied → interviewed → offered → hired funnel. |
| **Reviewable drafting** | Use your authenticated Gemini CLI to draft a tailored CV, recruiter message, and cover letter with instructions to use only supported facts. |
| **Clean CV PDFs** | Download a single-column PDF with selectable text, standard headings, and Unicode support, plus a mechanical ATS parse check. |
| **Human-controlled handoff** | Open installed Chrome, fill recognized empty fields, and attach the approved CV only when you choose Assisted apply. |
| **A local dashboard and CLI** | Search, filter, skip, restore, review, approve, and track applications without a hosted account. |

**Match scores are heuristics, and the ATS parse check is a mechanical text-layer inspection — neither is an ATS certification or a prediction of hiring success.** The score allocates up to 50 points to role alignment, 40 to CV-supported job terms, and 10 to location alignment.

## How it works

```mermaid
flowchart TD
    CV["Your CV + role and location preferences"] --> Profile["Save your local profile"]
    Boards["Connected Greenhouse / Lever boards"] --> Scan["Scan public openings"]
    Search["Role + location search"] --> JobSpy["Optional JobSpy: LinkedIn / Indeed"]
    JobSpy --> Matches
    Profile --> Matches["Rank, search, and filter matches"]
    Scan --> Matches
    Matches -->|"Choose a job and select Prepare"| Gemini["Gemini CLI drafts application materials"]
    Gemini --> Draft["Tailored CV + recruiter message + cover letter"]
    Draft --> Review{"Your review"}
    Review -->|"Edit and save"| Draft
    Review -->|"Approve"| Approved["Approved application + CV PDF"]
    Approved -->|"Consent to sharing with the portal"| Chrome["Open or reuse Chrome; prefill recognized forms"]
    Chrome --> Manual["You handle login, CAPTCHA, screening, and submission"]
    Manual -->|"Confirm submission in ProofLoop"| Tracker["Count submissions + distinct companies"]
    Tracker -->|"You hear back and record it"| Outcome["Outcome history + cumulative funnel"]
    Draft --> Log["Local timestamped application activity"]
    Approved --> Log
    Chrome --> Log
    Tracker --> Log
    Outcome --> Log

    classDef local fill:#e5f1eb,stroke:#2d6a57,color:#17253d
    classDef external fill:#edf0f8,stroke:#526688,color:#17253d
    classDef human fill:#fff2d9,stroke:#b68432,color:#17253d
    class CV,Profile,Scan,Matches,Draft,Approved,Tracker,Outcome,Search,Log local
    class Boards,JobSpy,Gemini,Chrome external
    class Review,Manual human
```

Scanning, drafting, and assisted apply are user-triggered. If Chrome encounters login or CAPTCHA, complete it yourself and retry **Assisted apply** on the same tab. Unrecognized forms and different-site redirects may require manual completion.

Application states are **Draft → Approved → Submitted**. The last transition records your confirmation; it never presses a portal's Submit button. Post-submission outcomes are a separate, user-recorded history layer: they append to the activity log and funnel without changing the confirmed submission.

## Quick start

### 1. Check prerequisites

- **[Bun](https://bun.sh) 1.4.4 or newer** — ProofLoop's package manager, runtime, and test runner.
- **Git** — to clone the repository; your GitHub account needs access if it is private.
- **Gemini CLI** — available as `gemini` on your PATH and authenticated with your Google account.
- **Installed Google Chrome** — required for assisted apply and browser integration tests, not for basic dashboard browsing.

If Gemini CLI is not installed, install its package through Bun, then sign in interactively:

```bash
bun add --global @google/gemini-cli
gemini
```

Gemini CLI is an external tool with its own upstream runtime requirements. ProofLoop invokes your existing installation; it does not manage your Google login.

> [!NOTE]
> ProofLoop does not require a Gemini Developer API key. Access, quotas, and subscription eligibility depend on your Google account and CLI authentication method; an existing subscription is not a guarantee of unlimited usage.

### 2. Install and run

```bash
git clone https://github.com/vedantparmar12/proofloop.git
cd proofloop
bun install --frozen-lockfile
bun run dev
```

Open **[http://127.0.0.1:3000](http://127.0.0.1:3000)**.

For a server without file watching, use `bun run start`. Keep the server terminal open while using the dashboard or CLI.

### 3. Make your first application draft

1. Open **Profile & sources**, add your CV and preferences, and select **Save profile**.
2. Connect a real company's Greenhouse or Lever board using its board slug.
3. Open **Jobs** and select **Scan sources**.
4. Inspect a relevant opening and select **Prepare**.
5. In **Review**, verify the generated materials, edit them, and approve only when ready.
6. In **Applications**, download your CV PDF or explicitly choose **Assisted apply**.
7. Submit in the job portal yourself, then use **Confirm submitted** to update your tracker.
8. When you hear back, record the outcome yourself in **Applications**; the funnel updates from your entries, not from email or portal monitoring.

### Optional: broader discovery with JobSpy

Install **Python 3.10+**, available as `python`, then run:

```bash
bun run setup:jobspy
```

This creates an isolated Python environment inside `.data/jobspy-venv` and uses its `python -m pip` to install pinned `python-jobspy==1.4.1`. **ProofLoop's server, CLI, tests, and setup command still run on Bun.** Python runs only the upstream discovery library. Existing company-board scans work without this optional dependency.

Open **Jobs → Search job boards with JobSpy**, select **Indeed** or **LinkedIn**, and enter your role, location, country, result limit, and posting age. Or run:

```bash
bun run cli search indeed "Software Engineer" "Bengaluru" india
```

- Searches send only search settings, not your CV or contact details. Use each provider only where permitted by its terms.
- One search runs at a time, with up to **25 results**, a **90-second deadline**, and a **60-second cooldown** after completion. There are no automatic retries or proxy controls.
- Provider errors and warnings remain visible even with partial results. A zero-result response is not proof that no matching jobs exist.
- Repeated provider IDs update existing jobs. Cross-provider duplicates and company aliases are **not** automatically merged; review before applying twice.
- Listings without descriptions can be opened manually but cannot generate drafts.
- This integration enables **Indeed and LinkedIn only**. Naukri and other impersonating JobSpy connectors are not enabled. Google discovery is unavailable upstream. Portal login, CAPTCHA, screening, and submission remain manual.

Upstream: [speedyapply/JobSpy](https://github.com/speedyapply/JobSpy), [MIT license](https://github.com/speedyapply/JobSpy/blob/main/LICENSE). JobSpy discovers openings; it does not submit applications. No paid discovery API key is required, but network access and provider availability are not guaranteed.

## Dashboard guide

### Profile & sources

- Enter contact details, comma-separated target roles and locations, and a minimum match threshold.
- Paste your master CV or upload **PDF, DOCX, TXT, or MD**, up to **8 MB**. PDFs must have selectable text and no more than **20 pages**; OCR is not included.
- Uploading extracts text into the editor; **review the extracted text and save your profile** to persist it.
- Select Greenhouse or Lever and enter the company's board slug, not its full URL. A slug is the company identifier in the board's address; it may differ from the display name.
- Profile preferences affect subsequent scans; scan again after changing them to refresh rankings.

### Jobs

- Search by **title or company**.
- Switch between **Open matches**, **All jobs**, and **Skipped**.
- Enable **Above my threshold** to include scores at or above your saved minimum.
- Use **View** to read the description, **Skip** to hide an opening from the open inbox, or **Restore** to bring it back.
- Preparing an application sends your CV/profile details and the selected job description to Gemini. An existing application prevents preparing a duplicate for that job.

### Review

- Edit the **tailored CV**, **recruiter message**, and **cover letter**. Generated text is a draft, not verified evidence.
- **Save edits** saves only that application. **Approve application** validates and saves the current form before approval.
- Check dates, employers, skills, metrics, contact details, and the downloaded PDF before approval. Approved applications are no longer editable in the current UI.
- **ATS parse check** runs when the PDF is created and refreshes on save or approval. It verifies selectable text, a clean text layer, and the presence of your saved name, email, and phone. Warnings and failures are advisory and never block review or approval.
- The dashboard warns before navigating away from unsaved profile or draft edits.

### Applications

- Summary cards separate **companies applied to**, **confirmed submissions**, **approved but unsubmitted**, and **drafts**. Two confirmed applications to one company count as two submissions and one company.
- The **outcome funnel** counts cumulative stage reached for submitted applications: an application interviewed and later rejected still counts under **Interviewed**, and an offer or hire also counts as an interview. **Offered** and **Hired** follow the same cumulative rule.
- A submitted application with no recorded outcome is **awaiting an outcome**. After **10 quiet days** it is flagged as ready for a follow-up; this is a local reminder, not a sent message.
- Record **Interview, Offer, Rejected, Hired, Withdrawn, or No response** on any submitted application, with an optional note up to 500 characters. Outcomes are append-only history; they do not contact the employer, send a follow-up, or change the confirmed submission.
- Company grouping ignores case and extra whitespace, not aliases, subsidiaries, or spelling differences. Blank company names are excluded from the distinct-company count.
- **Application activity** records draft creation/edits, approval, browser assistance or pauses/failures, user-confirmed submission, and recorded outcomes. Load older events to browse beyond the newest 50. Times are UTC; event details do not copy CVs or contact fields.
- Existing databases receive a clearly labeled historical-state entry on upgrade. Earlier actions are not invented, and existing submission dates are preserved. Repeated submission requests cannot reset dates or inflate counts.
- **CV PDF** downloads the document; the status row shows the latest ATS parse result; **Open job** opens the original posting.
- **Assisted apply** is available only for approved applications. It opens a visible, separate Chrome profile and reuses that application's tab on retries.
- Prefill requires one unambiguous CV upload input in a recognized form. It fills only empty, editable, recognized contact or cover-letter fields and preserves existing values and selected attachments.
- Review every field in Chrome. Screening answers, consent checkboxes, and submission remain your responsibility.
- The recruiter message is a draft for you to copy and send; ProofLoop does not automatically contact recruiters.

> [!WARNING]
> Assisted apply shares contact details, the reviewed cover letter, and your CV with the portal. File attachments may upload immediately, before final submission. Use it only where you have permission and automated prefill is permitted.

> [!NOTE]
> Outcomes are never detected automatically. ProofLoop does not connect to email, monitor portal replies, contact employers, or send follow-ups. Record an outcome only when you have actually received it.

## CLI reference

Run these commands from the project root **while the local server is running**. Replace placeholders with IDs from your dashboard or CLI output.

| Command | Purpose |
| --- | --- |
| `bun run cli status` | Summarize jobs, matches, drafts, approvals, confirmed submissions, and distinct companies applied to. |
| `bun run cli log [before-event-id]` | Read 50 newest activity entries; pass the returned `nextBefore` value for older entries. |
| `bun run cli search <indeed\|linkedin> "<role>" "<location>" [country]` | Search JobSpy with 15-result/seven-day defaults; country defaults to `india`. |
| `bun run cli scan` | Scan connected public job boards. |
| `bun run cli list` | List up to 30 open jobs, their scores, and IDs. |
| `bun run cli prepare <job-id>` | Create a draft for one job. |
| `bun run cli approve <application-id>` | Approve the saved draft after your review. |
| `bun run cli assist <application-id>` | Open or retry an approved application's Chrome handoff. |
| `bun run cli submitted <application-id>` | Record submission after you have verified it in the portal. |
| `bun run cli outcome <application-id> <interview\|offer\|rejected\|hired\|withdrawn\|no_response> [note]` | Record an outcome you actually received for a submitted application. |

CLI commands are direct API actions and do not display the dashboard's confirmation dialogs. Approve only reviewed materials, obtain permission before sharing documents, and never mark submitted before verifying the actual portal submission. Unlike dashboard approval, CLI approval uses the draft already saved on the server. Outcomes can be recorded only after confirmed submission, are never inferred, and do not contact the employer.

### Claude skill

The project includes [`.claude/skills/job-agent/SKILL.md`](.claude/skills/job-agent/SKILL.md) for a compatible Claude skill client. It documents the CLI workflow and requires explicit human approval and permission to share application data. The skill uses the same running local service; it does not add a separate application engine.

## Configuration

Defaults work without an `.env` file. If needed, set environment variables or create a local `.env` file, which Bun loads and Git excludes:

```dotenv
PORT=3000
DATA_DIRECTORY=.data
PROOFLOOP_URL=http://127.0.0.1:3000
```

| Variable | Used by | Meaning |
| --- | --- | --- |
| `PORT` | Server | Local listening port; defaults to `3000`. |
| `DATA_DIRECTORY` | Server | SQLite, generated PDFs, and persistent Chrome profile location; defaults to `.data` relative to the working directory. |
| `PROOFLOOP_URL` | CLI | Address of the running service; update it if you change the server port. |
| `JOBSPY_PYTHON` | Discovery | Optional absolute path to a Python executable with JobSpy installed; defaults to the isolated environment under `DATA_DIRECTORY/jobspy-venv`. |

The server binds to `127.0.0.1`. Start commands from the project root. If you move `DATA_DIRECTORY`, exclude the new location from Git before storing personal data there.

## Privacy and data

**Local-first does not mean offline.** Your records stay on your machine, but scanning, drafting, and assisted apply have explicit network boundaries.

| Data or action | Destination |
| --- | --- |
| Profile, job records, application text, statuses, outcome events, ATS check results, and activity history | Local `.data/proofloop.sqlite`. |
| JobSpy role/location search | Selected LinkedIn or Indeed provider; no CV or contact details are sent. |
| JobSpy dependency installation | Python package index; installed into local `.data/jobspy-venv`. |
| Generated CV PDFs | Local `.data` directory. |
| Assisted browser cookies and sessions | Separate local `.data/chromium-profile` directory, not your everyday Chrome profile. |
| Public job scans | The configured Greenhouse or Lever board APIs. |
| Draft generation | Gemini through your installed, authenticated CLI. |
| Assisted prefill and attachments | The job portal opened in Chrome. |

`.data/`, `.env`, `node_modules/`, and `*.log` are excluded from Git. Protect local backups too: the data directory contains personal documents and browser session information. Stop the app and its assisted Chrome session before backing up the entire data directory.

There is no multi-user authentication or production hosting setup. **Do not expose this local service publicly or through an unauthenticated tunnel.**

## Development and tests

```bash
bun run dev                  # Bun server with file watching
bun run start                # Bun server without file watching
bun run test                 # Bun tests with per-file isolation
bun audit                    # Dependency vulnerability audit
```

Use `bun run test` rather than bare `bun test`: the script enables `--isolate` so temporary database state does not leak between test files. Install Chrome before running the browser tests.

Coverage includes matching, feed/JobSpy normalization, worker isolation and failure handling, Unicode PDFs, escaped HTML, database migrations and atomic event logs, distinct-company and cumulative outcome metrics, ATS text-layer checks, dashboard search/approval, and conservative assisted prefill. Tests use temporary databases, fixture feeds, and fake Gemini/JobSpy executables; Python is not required for the regular suite. They do not call live Gemini or job boards, or submit real applications.

<details>
<summary><strong>Project structure</strong></summary>

```text
proofloop/
├── .claude/skills/job-agent/  Claude skill instructions
├── public/                   Dashboard shell, CSS, and HTMX event glue
├── src/
│   ├── server.js             Local Express server, JSON API, and HTML fragments
│   ├── views.js              Escaped server-rendered dashboard templates
│   ├── db.js                 SQLite records, event triggers, and tracking/funnel metrics
│   ├── outcomes.js           Shared outcome stages, labels, and follow-up timing
│   ├── connectors.js         Greenhouse and Lever feed adapters
│   ├── jobspy.js             Bounded Bun-to-Python discovery bridge and setup
│   ├── jobspy_worker.py      JobSpy search and result serialization
│   ├── matcher.js            CV-supported heuristic job ranking
│   ├── gemini.js             Gemini CLI prompts and validated draft output
│   ├── documents.js          CV text extraction, PDF generation, and ATS checks
│   ├── assistedApply.js      Visible Chrome sessions and conservative prefill
│   └── cli.js                Local API command-line client
├── test/                     Rendering, document, and browser regression tests
├── bun.lock                  Reproducible Bun dependency resolution
├── requirements-jobspy.txt   Pinned optional Python discovery dependency
└── package.json              Bun commands and dependencies
```

The HTMX dashboard receives HTML fragments from Express; the CLI uses the same server's JSON API. HTMX is served locally from the installed dependency, not a CDN.

</details>

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| CLI reports `fetch failed` | Start `bun run dev`; ensure `PROOFLOOP_URL` matches the server port. |
| Gemini is missing or unauthenticated | Check `gemini --version`, run `gemini` interactively, sign in with Google, and retry. |
| Gemini times out or returns an incomplete draft | Check your CLI session and quota, then retry. Draft generation has a 120-second timeout. |
| No jobs appear | Check board slugs or JobSpy settings, inspect provider errors, and relax search/status/threshold filters. |
| JobSpy is missing or the worker fails | Ensure `python --version` is 3.10+, run `bun run setup:jobspy`, and retry after the cooldown. Check `JOBSPY_PYTHON` if customized. |
| JobSpy is blocked, busy, or times out | Wait before a manual retry, or use public company boards. There is no CAPTCHA bypass or automatic retry. Partial results may be incomplete. |
| Uploaded PDF has no usable text | Use a selectable-text PDF, DOCX, TXT, or Markdown CV; scanned-image OCR is not supported. |
| Chrome cannot launch | Install Google Chrome; assisted apply uses Playwright's `chrome` channel, not a bundled browser download. |
| Assisted apply pauses for login or CAPTCHA | Complete it yourself in the opened tab, navigate to the application form, then select Assisted apply again. |
| Form is unrecognized or the tab changes sites | Complete the portal manually; ProofLoop will not guess fields or follow a different-site handoff automatically. |
| ATS check reports warnings or needs attention | Confirm the downloaded PDF has selectable text and that your saved name, email, and phone appear correctly. The check is advisory and cannot replicate a specific employer's parser. |
| Outcome form is unavailable | Confirm the application is **submitted**. Outcomes cannot be recorded on drafts or approved-but-unsubmitted applications. |

## Current boundaries

- Discovery supports **public Greenhouse and Lever company boards** and optional **LinkedIn/Indeed search via JobSpy**. Naukri and other JobSpy providers are not enabled; no platform-specific application submission is implemented.
- Scans are manual. There is no scheduled background search, mass application sending, email automation, or WhatsApp integration.
- There is no CAPTCHA solving, stealth browser behavior, automated screening, or final portal submission.
- Outcomes are user-recorded only. There is no email or portal-reply sync, outcome inference, employer contact, or follow-up sending; the 10-day flag is a local reminder.
- Drafts require fact-checking. PDF formatting, match scores, and the mechanical ATS check cannot guarantee ATS acceptance or interviews.
- The server runs on your computer and stops being available when that computer is off.

---

<div align="center">

**Find the fit. Verify the facts. Stay in control.**

</div>
