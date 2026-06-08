import { google } from "googleapis";
import { WebClient } from "@slack/web-api";
import express from "express";

const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const GOOGLE_SHEET_ID      = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const FEEDBACK_LOG_CHANNEL = process.env.FEEDBACK_LOG_CHANNEL;
// ───────────────────────────────────────────────────────────────────────────

const slack = new WebClient(SLACK_BOT_TOKEN);

const auth = new google.auth.JWT(GOOGLE_CLIENT_EMAIL, null, GOOGLE_PRIVATE_KEY, [
  "https://www.googleapis.com/auth/spreadsheets",
]);
const sheets = google.sheets({ version: "v4", auth });

const processedEvents = new Set();

// ─── MOCK Claude extraction ─────────────────────────────────────────────────
function mockExtractFeedback(messages) {
  return {
    date: new Date().toISOString().split("T")[0],
    author: "mock_user",
    raw_message: messages,
    summary: "[MOCK] This is a simulated feedback summary.",
    feature: "onboarding",
    priority: "Medium",
    action_items: "Review onboarding flow | Add clearer tooltips",
  };
}
// ───────────────────────────────────────────────────────────────────────────

app.post("/slack/events", async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") return res.json({ challenge });

  res.sendStatus(200);

  if (event?.type !== "app_mention") return;

  if (processedEvents.has(event.event_ts)) return;
  processedEvents.add(event.event_ts);
  setTimeout(() => processedEvents.delete(event.event_ts), 60_000);

  try {
    // 1. Fetch the thread
    const threadTs = event.thread_ts || event.ts;
    const threadResult = await slack.conversations.replies({
      channel: event.channel,
      ts: threadTs,
    });

    const messages = threadResult.messages
      .filter((m) => m.ts !== event.ts)
      .map((m) => `${m.username || m.user}: ${m.text}`)
      .join("\n");

    if (!messages.trim()) {
      await slack.reactions.add({ channel: event.channel, timestamp: event.ts, name: "warning" });
      return;
    }

    // 2. Mock extraction (no Claude API call)
    const feedback = mockExtractFeedback(messages);
    console.log("📦 Mock feedback extracted:", feedback);

    // 3. Append to Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Sheet1!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          feedback.date,
          feedback.author,
          feedback.raw_message,
          feedback.summary,
          feedback.feature,
          feedback.priority,
          feedback.action_items,
        ]],
      },
    });

    // 4. Post to #feedback-log
    await slack.chat.postMessage({
      channel: FEEDBACK_LOG_CHANNEL,
      text: `📥 *[MOCK] New feedback logged*

*Author:* ${feedback.author}
*Feature:* ${feedback.feature}
*Priority:* ${feedback.priority}
*Summary:* ${feedback.summary}
*Action items:* ${feedback.action_items}`,
    });

    // 5. React ✅ on the @mention
    await slack.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name: "white_check_mark",
    });

  } catch (err) {
    console.error("Error:", err);
    await slack.reactions.add({ channel: event.channel, timestamp: event.ts, name: "x" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Feedback bot (MOCK MODE) running on port ${PORT}`));
