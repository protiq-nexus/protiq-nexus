function playerIdFromEmail(email) {
  const s = String(email || "x");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return 1000 + (hash % 9000);
}

function publicName(row) {
  const email = String(row.user_email || row.email || "");
  const local = email.split("@")[0] || "";
  const custom = String(row.display_name || "").trim();
  if (
    custom &&
    !custom.includes("@") &&
    custom.toLowerCase() !== local.toLowerCase() &&
    custom.toLowerCase() !== local.split("+")[0].toLowerCase()
  ) {
    return custom;
  }
  return "Player #" + playerIdFromEmail(email);
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
    const action = url.searchParams.get("action") || "list";

    if (!email) {
      return Response.json({ error: "email required" }, { status: 400 });
    }

    if (action === "search") {
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) {
        return Response.json({ success: true, users: [] });
      }
      const result = await env.DB.prepare(
        `SELECT user_email, display_name, total_points
         FROM leaderboard
         WHERE lower(COALESCE(display_name, '')) LIKE ? OR lower(user_email) LIKE ?
         LIMIT 20`
      )
        .bind("%" + q + "%", "%" + q + "%")
        .all();

      const users = (result.results || [])
        .filter((u) => u.user_email !== email)
        .map((u) => ({
          display_name: publicName(u),
          points: u.total_points || 0,
          key: u.user_email,
        }));

      return Response.json({ success: true, users });
    }

    if (action === "pending") {
      const result = await env.DB.prepare(
        `SELECT c.from_email, l.display_name, l.total_points, c.created_at
         FROM connections c
         LEFT JOIN leaderboard l ON l.user_email = c.from_email
         WHERE c.to_email = ? AND c.status = 'pending'
         ORDER BY c.created_at DESC`
      )
        .bind(email)
        .all();

      const requests = (result.results || []).map((r) => ({
        from_key: r.from_email,
        display_name: publicName({ user_email: r.from_email, display_name: r.display_name }),
        points: r.total_points || 0,
      }));

      return Response.json({ success: true, requests });
    }

    // friends list (accepted both ways stored as one direction rows)
    const result = await env.DB.prepare(
      `SELECT
         CASE WHEN c.from_email = ? THEN c.to_email ELSE c.from_email END AS friend_email,
         l.display_name,
         l.total_points
       FROM connections c
       LEFT JOIN leaderboard l
         ON l.user_email = CASE WHEN c.from_email = ? THEN c.to_email ELSE c.from_email END
       WHERE c.status = 'accepted'
         AND (c.from_email = ? OR c.to_email = ?)
       ORDER BY l.total_points DESC`
    )
      .bind(email, email, email, email)
      .all();

    const friends = (result.results || []).map((f) => ({
      key: f.friend_email,
      display_name: publicName({ user_email: f.friend_email, display_name: f.display_name }),
      points: f.total_points || 0,
    }));

    return Response.json({ success: true, friends });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not load connections" }, { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const action = String(body.action || "").trim();
    const target = String(body.target || "").trim().toLowerCase();

    if (!email || !action) {
      return Response.json({ error: "email and action required" }, { status: 400 });
    }

    if (action === "request") {
      if (!target || target === email) {
        return Response.json({ error: "invalid target" }, { status: 400 });
      }
      // ensure target exists on leaderboard or allow anyway
      await env.DB.prepare(
        `INSERT INTO connections (from_email, to_email, status, created_at)
         VALUES (?, ?, 'pending', datetime('now'))
         ON CONFLICT(from_email, to_email) DO UPDATE SET
           status = CASE WHEN connections.status = 'rejected' THEN 'pending' ELSE connections.status END`
      )
        .bind(email, target)
        .run();

      return Response.json({ success: true, message: "Request sent" });
    }

    if (action === "accept") {
      if (!target) return Response.json({ error: "target required" }, { status: 400 });
      await env.DB.prepare(
        `UPDATE connections SET status = 'accepted'
         WHERE from_email = ? AND to_email = ? AND status = 'pending'`
      )
        .bind(target, email)
        .run();
      return Response.json({ success: true, message: "Connected" });
    }

    if (action === "reject") {
      if (!target) return Response.json({ error: "target required" }, { status: 400 });
      await env.DB.prepare(
        `UPDATE connections SET status = 'rejected'
         WHERE from_email = ? AND to_email = ? AND status = 'pending'`
      )
        .bind(target, email)
        .run();
      return Response.json({ success: true, message: "Rejected" });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not update connection" }, { status: 500 });
  }
}
