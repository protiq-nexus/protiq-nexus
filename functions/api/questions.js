export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405 }
    );
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, topic, level, question, options,
             correct_answer, explanation
      FROM olympiad_questions
      ORDER BY id DESC
    `).all();

    return Response.json({
      success: true,
      questions: result.results || []
    });
  } catch (error) {
    console.error("Question API error:", error);

    return Response.json(
      { error: "Could not load questions." },
      { status: 500 }
    );
  }
}
