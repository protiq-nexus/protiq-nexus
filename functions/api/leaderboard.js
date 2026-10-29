function publicName(row) {
  const custom = String(row.display_name || "").trim();
  // ignore auto email-prefix style names that look like pure mailbox local-part only if you want —
  // if display_name was set from email split, treat empty/custom better:
  if (custom && !custom.includes("@")) {
    // still might be gmail local part; user can set real name later
    // prefer custom if not equal to generating from email only when length ok
  }
  if (custom && custom.length >= 2 && !custom.includes("@")) {
    return custom;
  }
  // stable pseudo id from email
  const email = String(row.user_email || "x");
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) >>> 0;
  }
  const id = 1000 + (hash % 9000);
  return "Player #" + id;
}

export async function onRequestGet({ env }) {
  try {
    const result = await env.DB.prepare(
      `SELECT display_name, total_points, user_email
       FROM leaderboard
       ORDER BY total_points DESC
       LIMIT 50`
    ).all();

    const leaders = (result.results || []).map((row) => ({
      display_name: publicName(row),
      total_points: row.total_points || 0,
      // email পাঠাবে না
    }));

    return Response.json({ success: true, leaders });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not load leaderboard" }, { status: 500 });
  }
}
