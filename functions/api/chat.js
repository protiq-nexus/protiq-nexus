// functions/api/chat.js
// Physics AI with a daily question limit:
//   - guests (not logged in): limited per IP address
//   - logged-in users: higher limit, per account

const SUPABASE_URL = "https://dylkrvdnyefdeuxtchji.supabase.co";
// Public "anon" key (the same one already used in the web pages). It is safe to keep here.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5bGtydmRueWVmZGV1eHRjaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODgxNjEsImV4cCI6MjEwODE2NDE2MX0.cs0XsVKkoo61FwJMitjSGx3vdmYsfWpqovl7kTfgAp4";

// Change these numbers any time
const GUEST_DAILY_LIMIT = 5;
const USER_DAILY_LIMIT = 30;

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Returns the user id if the login token is valid, otherwise null
async function getUserId(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user.id : null;
  } catch (e) {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.AI) {
      return Response.json(
        { error: "AI service is not configured yet." },
        { status: 503 }
      );
    }

    const body = await request.json();

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json(
        { error: "Please send a Physics question." },
        { status: 400 }
      );
    }

    const messages = body.messages
      .filter(
        (m) =>
          m &&
          ["user", "assistant"].includes(m.role) &&
          typeof m.content === "string"
      )
      .slice(-10)
      .map((m) => ({
        role: m.role,
        content: m.content.slice(0, 3000)
      }));

    if (messages.length === 0) {
      return Response.json(
        { error: "Please send a Physics question." },
        { status: 400 }
      );
    }

    // ---------- daily limit ----------
    const userId = await getUserId(request);
    const isUser = !!userId;
    const limit = isUser ? USER_DAILY_LIMIT : GUEST_DAILY_LIMIT;
    const day = new Date().toISOString().slice(0, 10); // UTC date

    if (env.DB) {
      let who;
      if (isUser) {
        who = "u:" + userId;
      } else {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        who = "g:" + (await sha256(ip)); // IP is stored only as a hash
      }

      const row = await env.DB.prepare(
        "INSERT INTO ai_usage (id, day, count) VALUES (?1, ?2, 1) " +
          "ON CONFLICT(id, day) DO UPDATE SET count = count + 1 RETURNING count"
      )
        .bind(who, day)
        .first();

      if (row && row.count > limit) {
        return Response.json(
          {
            error: isUser
              ? "You have reached today's limit of " + limit + " questions. Please try again tomorrow."
              : "Guests can ask " + limit + " questions per day. Login to ask more."
          },
          { status: 429 }
        );
      }
    } else if (!isUser) {
      // No database connected: do not leave the AI open to guests without a limit
      console.error("ai_usage database binding (env.DB) is missing");
      return Response.json(
        { error: "AI is available for logged-in users only right now." },
        { status: 503 }
      );
    }
    // ---------------------------------

    const result = await env.AI.run("@cf/zai-org/glm-4.7-flash", {
      messages: [
        {
          role: "system",
          content:
            "You are ProtiQ Nexus, a Physics tutor. Explain physics clearly, show equations when useful, and answer in the user's language."
        },
        ...messages
      ],
      max_tokens: 1200,
      chat_template_kwargs: {
        enable_thinking: false
      }
    });

    console.log("Workers AI result keys:", Object.keys(result ?? {}));

    const answer =
      result?.response ??
      result?.choices?.[0]?.message?.content ??
      result?.result?.response;

    if (typeof answer !== "string" || !answer.trim()) {
      return Response.json(
        { error: "AI returned no readable answer." },
        { status: 502 }
      );
    }

    return Response.json({ answer });
  } catch (error) {
    // Details stay in the server log only (not sent to the visitor)
    console.error("Physics AI error:", error);
    return Response.json({ error: "AI service failed." }, { status: 500 });
  }
}
