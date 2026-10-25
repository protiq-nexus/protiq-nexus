export async function onRequestGet({ env }) {
  try {
    if (!env.DB) {
      return Response.json(
        { error: "Database not configured." },
        { status: 500 }
      );
    }

    const result = await env.DB.prepare(`
      SELECT id, title, authors, abstract, subject, file_url, doi
      FROM research
      ORDER BY id DESC
    `).all();

    return Response.json({
      success: true,
      papers: result.results || []
    });
  } catch (error) {
    console.error("Research list error:", error);
    return Response.json(
      { error: "Could not load research papers." },
      { status: 500 }
    );
  }
}
