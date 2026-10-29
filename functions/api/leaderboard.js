export async function onRequestGet({ env }) {
  try {
    const result = await env.DB.prepare(
      `SELECT display_name, total_points, user_email
       FROM leaderboard
       ORDER BY total_points DESC
       LIMIT 20`
    ).all();

    return Response.json({
      success: true,
      leaders: result.results || [],
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not load leaderboard" }, { status: 500 });
  }
}
