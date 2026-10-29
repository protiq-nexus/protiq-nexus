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
    }));

    return Response.json({ success: true, leaders });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not load leaderboard" }, { status: 500 });
  }
}
