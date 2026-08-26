const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

type MailpitMessageSummary = { ID: string; To: { Address: string }[] };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GoTrue's response to signUp()/resetPasswordForEmail() doesn't guarantee
// the SMTP send has finished landing in Mailpit's own store by the time
// the client sees the response — poll for a few seconds rather than
// assuming the message is already there on the first check.
async function findLatestMessageTo(
  email: string,
  { retries = 10, delayMs = 500 } = {}
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    const body = (await res.json()) as { messages: MailpitMessageSummary[] };
    const match = body.messages.find((m) =>
      m.To.some((to) => to.Address.toLowerCase() === email.toLowerCase())
    );
    if (match) return match.ID;
    if (attempt < retries) await sleep(delayMs);
  }
  throw new Error(`No Mailpit message found for ${email}`);
}

export async function getLatestAuthLinkFor(email: string): Promise<string> {
  const id = await findLatestMessageTo(email);
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  const body = (await res.json()) as { HTML: string; Text: string };
  const source = body.HTML || body.Text;
  const match = source.match(/https?:\/\/[^\s"'<]+\/auth\/confirm\?[^\s"'<]+/);
  if (!match) {
    throw new Error(`No /auth/confirm link found in message to ${email}`);
  }
  return match[0];
}
