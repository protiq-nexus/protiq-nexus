function levelForPart(part) {
  if (part <= 1) return "Beginner";
  if (part === 2) return "Intermediate";
  return "Advanced";
}

function pointsPerCorrect(part) {
  if (part <= 1) return 10;
  if (part === 2) return 20;
  if (part === 3) return 30;
  return 30 + (part - 3) * 10;
}

function pointsForPart(part, correct) {
  let pts = correct * pointsPerCorrect(part);
  if (correct >= 7) pts += 40 + part * 10;
  return pts;
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const topic = url.searchParams.get("topic") || "Mechanics";
    const part = Math.max(1, parseInt(url.searchParams.get("part") || "1", 10));
    const level = levelForPart(part);

    const result = await env.DB.prepare(
      `SELECT id, topic, level, question, options, correct_answer, explanation
       FROM olympiad_questions
       WHERE topic = ? AND level = ?
       ORDER BY RANDOM()
       LIMIT 10`
    )
      .bind(topic, level)
      .all();

    const questions = (result.results || []).map((q) => {
      let options = q.options;
      try {
        options = typeof options === "string" ? JSON.parse(options) : options;
      } catch (e) {
        options = [];
      }
      const exp = String(q.explanation || "");
      const hint =
        exp.length > 12
          ? exp.slice(0, Math.min(90, Math.floor(exp.length * 0.45))) + "…"
          : "Think about the core formula or definition for this topic.";

      return {
        id: q.id,
        topic: q.topic,
        level: q.level,
        question: q.question,
        options,
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        hint,
      };
    });

    return Response.json({
      success: true,
      topic,
      part,
      level,
      points_per_correct: pointsPerCorrect(part),
      questions,
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not load quiz" }, { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const topic = String(body.topic || "").trim();
    const part = Math.max(1, parseInt(body.part || "1", 10));
    const correct = Math.max(0, parseInt(body.correct || "0", 10));
    const total = Math.max(1, parseInt(body.total || "10", 10));

    if (!email || !topic) {
      return Response.json({ error: "email and topic required" }, { status: 400 });
    }

    const earned = pointsForPart(part, correct);
    const unlockedNext = correct >= 7;
    const nextPart = unlockedNext ? part + 1 : part;

    const existing = await env.DB.prepare(
      `SELECT points, part FROM user_progress WHERE user_email = ? AND topic = ?`
    )
      .bind(email, topic)
      .first();

    const savedPart = Math.max(existing?.part || 1, nextPart);

    await env.DB.prepare(
      `INSERT INTO user_progress (user_email, topic, part, correct_count, total_attempted, points, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_email, topic) DO UPDATE SET
         part = excluded.part,
         correct_count = correct_count + excluded.correct_count,
         total_attempted = total_attempted + excluded.total_attempted,
         points = user_progress.points + excluded.points,
         updated_at = datetime('now')`
    )
      .bind(email, topic, savedPart, correct, total, earned)
      .run();

    const name = email.split("@")[0];
    await env.DB.prepare(
      `INSERT INTO leaderboard (user_email, display_name, total_points, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_email) DO UPDATE SET
         total_points = leaderboard.total_points + excluded.total_points,
         display_name = excluded.display_name,
         updated_at = datetime('now')`
    )
      .bind(email, name, earned)
      .run();

    return Response.json({
      success: true,
      correct,
      total,
      earned,
      unlockedNext,
      nextPart: savedPart,
      message: unlockedNext
        ? "Great! Part " + (part + 1) + " unlocked — harder set available."
        : "Need at least 7/10 to unlock the next harder part. Try again!",
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Could not save progress" }, { status: 500 });
  }
}
