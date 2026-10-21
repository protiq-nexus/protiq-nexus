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

    const result = await env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          {
            role: "system",
            content:
              "You are ProtiQ Nexus, a Physics tutor. Answer physics questions accurately, explain concepts clearly, show equations and step-by-step calculations when useful, define symbols and SI units, and reply in the user's language. State uncertainty honestly."
          },
          ...messages
        ],
        max_tokens: 1200
      }
    );

    if (!result?.response) {
      return Response.json(
        { error: "No answer returned. Please try again." },
        { status: 502 }
      );
    }

    return Response.json({ answer: result.response });
 
  } catch (error) {
    console.error("Physics AI error:", error);

    return Response.json(
      {
        error: "AI service failed.",
        details: String(error)
      },
      { status: 500 }
    );
  }

}
