// functions/api/leaderboard.js
// Leaderboard is visible only to logged-in users.

const SUPABASE_URL = "https://dylkrvdnyefdeuxtchji.supabase.co";
// Public "anon" key (the same one already used in the web pages). It is safe to keep here.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5bGtydmRueWVmZGV1eHRjaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODgxNjEsImV4cCI6MjEwODE2NDE2MX0.cs0XsVKkoo61FwJMitjSGx3vdmYsfWpqovl7kTfgAp4";

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

function playerIdFromEmail(email) {
  const s = String(email || "x");
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return 1000 + (hash % 9000);
}

function publicName(row) {
  const email = String(row.user_email || "");
  const local = email.split("@")[0] || "";
  const custom = String(row.display_name || "").trim();

  // auto name from gmail local-part → ignore
  if (
    custom &&
    !custom.includes("@") &&
    custom.toLowerCase() !== local.toLowerCase() &&
    custom.toLowerCase() !== local.split("+")[0].toLowerCase() &&
    !/^player\s*#?\d+$/i.test(custom)
  ) {
    return custom;
  }
  return "Player #" + playerIdFromEmail(email);
}

export async function onRequestGet({ request, env }) {
  try {
    // NEW: only logged-in users can see the leaderboard
    const userId = await getUserId(request);
    if (!userId) {
      return Response.json(
        { error: "Please login to view the leaderboard." },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const result = await env.DB.prepare(
      `SELECT display_name, total_points, user_email
       FROM leaderboard
       ORDER BY total_points DESC
       LIMIT 50`
    ).all();

    const leaders = (result.results || []).map((row) => ({
      display_name: publicName(row),
      total_points: row.total_points || 0,
    }));

    return Response.json(
      { success: true, leaders },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not load leaderboard" }, { status: 500 });
  }
}
