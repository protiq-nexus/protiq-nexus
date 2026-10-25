export async function onRequestPost({ request, env }) {
  let uploadedFileName = null;

  try {
    if (!env.DB || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      return Response.json(
        { error: "Server configuration is incomplete." },
        { status: 500 }
      );
    }

    const form = await request.formData();

    const title = String(form.get("title") || "").trim();
    const authors = String(form.get("authors") || "").trim();
    const abstract = String(form.get("abstract") || "").trim();
    const subject = String(form.get("subject") || "").trim();
    const doi = String(form.get("doi") || "").trim();
    const file = form.get("file");

    if (!title || !authors || !file || typeof file === "string") {
      return Response.json(
        { error: "Title, authors, and PDF file are required." },
        { status: 400 }
      );
    }

    if (
      title.length > 200 ||
      authors.length > 300 ||
      abstract.length > 5000 ||
      subject.length > 100 ||
      doi.length > 150
    ) {
      return Response.json(
        { error: "One or more fields exceed the allowed length." },
        { status: 400 }
      );
    }

    if (file.size === 0 || file.size > 10 * 1024 * 1024) {
      return Response.json(
        { error: "PDF must be smaller than or equal to 10 MB." },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const signature = new Uint8Array(bytes.slice(0, 5));

    if (String.fromCharCode(...signature) !== "%PDF-") {
      return Response.json(
        { error: "The uploaded file is not a valid PDF." },
        { status: 400 }
      );
    }

    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
    const secretKey = env.SUPABASE_SECRET_KEY;
    const fileName = `${crypto.randomUUID()}.pdf`;

    const uploadResponse = await fetch(
      `${baseUrl}/storage/v1/object/research-papers/${fileName}`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/pdf",
          "x-upsert": "false"
        },
        body: bytes
      }
    );

    if (!uploadResponse.ok) {
      console.error("Supabase upload failed:", uploadResponse.status);
      return Response.json(
        { error: "PDF upload failed. Check Supabase bucket settings." },
        { status: 502 }
      );
    }

    uploadedFileName = fileName;

    const result = await env.DB.prepare(`
      INSERT INTO research
        (title, authors, abstract, subject, file_url, doi)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(title, authors, abstract, subject, fileName, doi || null)
      .run();

    return Response.json(
      {
        success: true,
        id: result.meta?.last_row_id ?? null,
        message: "Research uploaded successfully."
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Research API error:", error);

    if (uploadedFileName && env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) {
      try {
        const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
        const key = env.SUPABASE_SECRET_KEY;

        await fetch(
          `${baseUrl}/storage/v1/object/research-papers/${uploadedFileName}`,
          {
            method: "DELETE",
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`
            }
          }
        );
      } catch (cleanupError) {
        console.error("Storage cleanup failed:", cleanupError);
      }
    }

    return Response.json(
      { error: "Unable to upload research. Please try again." },
      { status: 500 }
    );
  }
}
