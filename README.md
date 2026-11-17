# Canvas submission server

This server exposes one Canvas write operation:

`POST http://127.0.0.1:8787/v1/submit`

It is restricted to the course in `CANVAS_COURSE_ID`, binds only to localhost, requires a separate local bearer key, and requires the exact `X-Submission-Confirmation` phrase before it will submit anything. For file-upload assignments, send the transcript as the multipart `file` field; the server performs Canvas's upload-then-submit workflow.

## Setup

1. Add the Canvas token to macOS Keychain, using the service and account configured in `.env.example`:

```bash
read -s CANVAS_TOKEN
printf '\n'
security add-generic-password \
  -a canvas-api-token \
  -s canvas-submission-server \
  -w "$CANVAS_TOKEN" \
  -U
unset CANVAS_TOKEN
```

2. Copy `.env.example` to `.env`.
3. Fill in the Canvas base URL, the single course ID, `SERVER_API_KEY`, and the confirmation phrase. The Canvas token does not go in `.env`.
4. Run `npm install` and then `npm start`.

The server reads the token once from Keychain when it starts. It will exit rather than run if the Keychain item is missing.

Do not commit `.env` or share the Canvas token.

## Request examples

Transcript file submission:

```bash
curl -X POST http://127.0.0.1:8787/v1/submit \
  -H 'Authorization: Bearer YOUR_SERVER_API_KEY' \
  -H 'X-Submission-Confirmation: I CONFIRM THIS CANVAS SUBMISSION' \
  -F 'assignment_id=123' \
  -F 'submission_type=online_upload' \
  -F 'file=@chat-transcript.txt;type=text/plain'
```
