// functions/api/connect.js
// Friends: search players, send / accept / reject requests, list friends.
// Identity always comes from the login token (never from the page), and emails are never sent to the browser.

const SUPABASE_URL = "https://dylkrvdnyefdeuxtchji.supabase.co";
// Public "anon" key (the same one already used in the web pages). It is safe to keep here.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5bGtydmRueWVmZGV1eHRjaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODgxNjEsImV4cCI6MjEwODE2NDE2MX0.cs0XsVKkoo61FwJMitjSGx3vdmYsfWpqovl7kTfgAp4";

const MAX_PENDING_SENT = 50;

function json(data, status) {
  return Response.json(data, { status: status || 200, headers: { "Cache-Control": "private, no-store" } });
}

async function getUser(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id || !user.email) return null;
    return { id: user.id, email: String(user.email).toLowerCase() };
  } catch (e) {
    return null;
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function keyOf(email) { return (await sha256Hex("friend:" + email)).slice(0, 16); }

// same public names as the leaderboard (a custom name, or "Player #1234")
function playerIdFromEmail(email) {
  const s = String(email || "x");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return 1000 + (hash % 9000);
}
function publicName(row) {
  const email = String(row.user_email || "");
  const local = email.split("@")[0] || "";
  const custom = String(row.display_name || "").trim();
  if (
    custom &&
    !custom.includes("@") &&
    custom.toLowerCase() !== local.toLowerCase() &&
    custom.toLowerCase() !== local.split("+")[0].toLowerCase() &&
    !/^player\s*#?\d+$/i.test(custom)
  ) return custom;
  return "Player #" + playerIdFromEmail(email);
}

// All real players (they must have leaderboard activity)
async function loadPlayers(env) {
  const res = await env.DB.prepare(
    "SELECT display_name, total_points, user_email FROM leaderboard ORDER BY total_points DESC LIMIT 5000"
  ).all();
  const out = [];
  for (const r of res.results || []) {
    const email = String(r.user_email || "").toLowerCase();
    if (!email || email.startsWith("guest:")) continue;
    out.push({ email, key: await keyOf(email), name: publicName(r), points: r.total_points || 0 });
  }
  return out;
}

async function myLinks(env, me) {
  const res = await env.DB.prepare(
    "SELECT user_a, user_b, status FROM friend_links WHERE user_a = ? OR user_b = ?"
  ).bind(me, me).all();
  return res.results || [];
}

export async function onRequestGet({ request, env }) {
  try {
    const user = await getUser(request);
    if (!user) return json({ error: "Please login." }, 401);
    const me = user.email;
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "";
    const players = await loadPlayers(env);
    const byEmail = new Map(players.map((p) => [p.email, p]));
    const links = await myLinks(env, me);

    if (action === "search") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) return json({ users: [] });
      const state = new Map(); // email -> friends | sent | incoming
      for (const l of links) {
        const other = l.user_a === me ? l.user_b : l.user_a;
        state.set(other, l.status === "accepted" ? "friends" : (l.user_a === me ? "sent" : "incoming"));
      }
      const users = players
        .filter((p) => p.email !== me && p.name.toLowerCase().includes(q))
        .slice(0, 20)
        .map((p) => ({ key: p.key, display_name: p.name, points: p.points, state: state.get(p.email) || "none" }));
      return json({ users });
    }

    if (action === "pending") {
      const requests = links
        .filter((l) => l.status === "pending" && l.user_b === me)
        .map((l) => byEmail.get(l.user_a))
        .filter(Boolean)
        .map((p) => ({ from_key: p.key, display_name: p.name, points: p.points }));
      return json({ requests });
    }

    if (action === "list") {
      const friends = links
        .filter((l) => l.status === "accepted")
        .map((l) => byEmail.get(l.user_a === me ? l.user_b : l.user_a))
        .filter(Boolean)
        .sort((a, b) => b.points - a.points)
        .map((p) => ({ key: p.key, display_name: p.name, points: p.points }));
      return json({ friends });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const user = await getUser(request);
    if (!user) return json({ error: "Please login." }, 401);
    const me = user.email;
    const body = await request.json();
    const action = String(body.action || "");
    const target = String(body.target || "").trim();
    if (!["request", "accept", "reject"].includes(action) || !/^[0-9a-f]{16}$/.test(target)) {
      return json({ error: "Bad request." }, 400);
    }

    const players = await loadPlayers(env);
    const other = players.find((p) => p.key === target);
    if (!other) return json({ error: "Player not found." }, 404);
    if (other.email === me) return json({ error: "You cannot connect with yourself." }, 400);

    const existing = await env.DB.prepare(
      "SELECT user_a, user_b, status FROM friend_links WHERE (user_a = ?1 AND user_b = ?2) OR (user_a = ?2 AND user_b = ?1)"
    ).bind(me, other.email).first();

    if (action === "request") {
      if (existing) {
        if (existing.status === "accepted") return json({ message: "You are already friends." });
        if (existing.user_a === me) return json({ message: "Request already sent." });
        // they already asked me: accept it
        await env.DB.prepare("UPDATE friend_links SET status = 'accepted' WHERE user_a = ? AND user_b = ?").bind(other.email, me).run();
        return json({ message: "You are now friends!", state: "friends" });
      }
      const sent = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM friend_links WHERE user_a = ? AND status = 'pending'"
      ).bind(me).first();
      if (sent && sent.c >= MAX_PENDING_SENT) {
        return json({ error: "You have too many pending requests. Please wait for replies." }, 429);
      }
      await env.DB.prepare("INSERT INTO friend_links (user_a, user_b, status) VALUES (?, ?, 'pending')").bind(me, other.email).run();
      return json({ message: "Request sent.", state: "sent" });
    }

    // accept / reject: only a pending request that was sent TO me
    if (!existing || existing.status !== "pending" || existing.user_b !== me) {
      return json({ error: "No pending request from this player." }, 404);
    }
    if (action === "accept") {
      await env.DB.prepare("UPDATE friend_links SET status = 'accepted' WHERE user_a = ? AND user_b = ?").bind(other.email, me).run();
      return json({ message: "You are now friends!", state: "friends" });
    }
    await env.DB.prepare("DELETE FROM friend_links WHERE user_a = ? AND user_b = ? AND status = 'pending'").bind(other.email, me).run();
    return json({ message: "Request removed.", state: "none" });
  } catch (error) {
    console.error(error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
