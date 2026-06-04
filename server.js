import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { WebClient } from "@slack/web-api";
import express from "express";

const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID; // from your Sheet URL
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
// ───────────────────────────────────────────────────────────────────────────

const slack = new WebClient(SLACK_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Google Sheets auth via Service Account
const auth = new google.auth.JWT(GOOGLE_CLIENT_EMAIL, null, GOOGLE_PRIVATE_KEY, [
  "https://www.googleapis.com/auth/spreadsheets",
]);
const sheets = google.sheets({ version: "v4", auth });

// Prevent duplicate processing
const processedEvents = new Set();

// ─── SLACK EVENTS ──────────────────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
  const { type, challenge, event } = req.body;

  // Slack URL verification handshake
  if (type === "url_verification") return res.json({ challenge });

  res.sendStatus(200);

  // Only handle @mentions
  if (event?.type !== "app_mention") return;

  // Deduplicate
  if (processedEvents.has(event.event_ts)) return;
  processedEvents.add(event.event_ts);
  setTimeout(() => processedEvents.delete(event.event_ts), 60_000);

  try {
    // 1. Fetch the thread (or just the message if no thread)
    const threadTs = event.thread_ts || event.ts;
    const threadResult = await slack.conversations.replies({
      channel: event.channel,
      ts: threadTs,
    });

    // Exclude the @mention message itself, keep the rest
    const messages = threadResult.messages
      .filter((m) => m.ts !== event.ts)
      .map((m) => `${m.username || m.user}: ${m.text}`)
      .join("\n");

    if (!messages.trim()) {
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "⚠️ I couldn't find any message to extract feedback from. Make sure to @mention me inside a thread containing the feedback.",
      });
      return;
    }

    // 2. Ask Claude to extract structured feedback
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `You are a product feedback analyst. Extract structured feedback from the following Slack conversation.

Return ONLY a JSON object with these exact fields:
- date: today's date in YYYY-MM-DD format
- author: the name of the person who gave the feedback (not the one asking you)
- raw_message: the original feedback message, verbatim
- summary: a one-sentence summary of the feedback
- feature: the specific software feature or area being discussed (e.g. "onboarding", "export", "dashboard", "notifications"). Infer it from context.
- priority: one of "High", "Medium", or "Low" based on the urgency and impact of the feedback
- action_items: a concise list of concrete things to do, separated by " | "

Slack conversation:
${messages}`,
        },
      ],
    });

    const raw = claudeResponse.content[0].text.trim();
    const jsonStr = raw.replace(/```json|```/g, "").trim();
    const feedback = JSON.parse(jsonStr);

    // 3. Append a row to Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Sheet1!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            feedback.date,
            feedback.author,
            feedback.raw_message,
            feedback.summary,
            feedback.feature,
            feedback.priority,
            feedback.action_items,
          ],
        ],
      },
    });

    // 4. Reply in the Slack thread
    await slack.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `✅ *Feedback logged!*

> *Summary:* ${feedback.summary}
> *Feature:* ${feedback.feature}
> *Priority:* ${feedback.priority}
> *Action items:* ${feedback.action_items}`,
    });
  } catch (err) {
    console.error("Error processing feedback:", err);
    await slack.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "❌ Something went wrong while processing the feedback. Please try again.",
    });
  }
});

app.listen(3000, () => console.log("✅ Feedback bot running on port 3000"));
