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
              "You are ProtiQ Nexus, a Physics tutor. Explain physics clearly, show equations when useful, and answer in the user's language."
          },
          ...messages
        ],
        max_tokens: 1200,
        chat_template_kwargs: {
          enable_thinking: false
        }
      }
    );

    console.log(
      "Workers AI result keys:",
      Object.keys(result ?? {})
    );

    const answer =
      result?.response ??
      result?.choices?.[0]?.message?.content ??
      result?.result?.response;

    if (typeof answer !== "string" || !answer.trim()) {
      return Response.json(
        {
          error: "AI returned no readable answer.",
          resultKeys: Object.keys(result ?? {})
        },
        { status: 502 }
      );
    }

    return Response.json({ answer });
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
