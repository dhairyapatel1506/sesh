import { env } from "./db.js";

// Telling someone a bug report arrived.
//
// Collecting reports into a table and never mentioning them is barely better
// than not collecting them — the first version of this feature did exactly
// that, and a report sat unread until somebody thought to go looking. So a
// report now sends mail.
//
// Resend over its HTTP API rather than SMTP or a library: it's one fetch with
// an API key, which means no dependency, no connection pooling, and nothing to
// go wrong at boot on a free instance that sleeps.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Everything here is optional. With no key configured, reports still land in
// the database and the dashboard still shows them — the app just doesn't send
// mail, exactly as it behaved before.
export const mailEnabled = () => Boolean(env("RESEND_API_KEY") && env("REPORT_EMAIL_TO"));

// Resend will only send from a domain you've verified. Until that's done its
// own onboarding sender works, but only to the address that owns the account —
// which is fine for a report inbox of one.
const from = () => env("REPORT_EMAIL_FROM") ?? "Sesh <onboarding@resend.dev>";

// A burst shouldn't turn an inbox into a denial of service against its owner.
// The rate limits on the endpoint make this unlikely, but "unlikely" is not a
// reason to leave a mail loop uncapped.
const BURST_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
let sentAt: number[] = [];

function withinBurst(): "send" | "last" | "silent" {
  const now = Date.now();
  sentAt = sentAt.filter((at) => at > now - HOUR_MS);
  if (sentAt.length < BURST_PER_HOUR) return "send";
  // One note that the rest are being held, then nothing until the hour rolls.
  return sentAt.length === BURST_PER_HOUR ? "last" : "silent";
}

type ReportMail = {
  id: string;
  text: string;
  client: string;
  roomId: string | null;
  reporter: string | null;
  userAgent: string | null;
  image: { data: Buffer; mime: string } | null;
  dashboardUrl: string | null;
};

async function post(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend responded ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Fire-and-forget. A report that was successfully stored must never fail
 * because a mail provider was having a bad afternoon — the person who filed it
 * has already been thanked, and the row is safe either way.
 */
export async function sendReportMail(report: ReportMail): Promise<void> {
  if (!mailEnabled()) return;
  const state = withinBurst();
  if (state === "silent") return;
  sentAt.push(Date.now());

  try {
    if (state === "last") {
      await post({
        from: from(),
        to: [env("REPORT_EMAIL_TO")],
        subject: "Sesh — more bug reports than usual",
        text:
          `That's ${BURST_PER_HOUR} reports in an hour, so the rest aren't being emailed ` +
          `until it settles down.\n\n` +
          (report.dashboardUrl ? `They're all here: ${report.dashboardUrl}\n` : ""),
      });
      return;
    }

    const where = report.roomId ? `room ${report.roomId}` : "no room";
    const who = report.reporter ?? "someone signed out";
    const lines = [
      report.text,
      "",
      "—",
      `from:    ${who} (${report.client}, ${where})`,
      report.userAgent ? `browser: ${report.userAgent}` : null,
      report.dashboardUrl ? `all reports: ${report.dashboardUrl}` : null,
    ].filter(Boolean);

    await post({
      from: from(),
      to: [env("REPORT_EMAIL_TO")],
      // The first line of the report itself, so the inbox is scannable without
      // opening anything.
      subject: `Sesh bug: ${report.text.replace(/\s+/g, " ").slice(0, 70)}`,
      text: lines.join("\n"),
      ...(report.image
        ? {
            attachments: [
              {
                filename: `screenshot.${report.image.mime.split("/")[1] ?? "png"}`,
                content: report.image.data.toString("base64"),
              },
            ],
          }
        : {}),
    });
  } catch (err) {
    console.error("couldn't email that bug report:", (err as Error).message);
  }
}
