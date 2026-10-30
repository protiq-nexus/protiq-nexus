// functions/api/research.js
// Uploading a research paper needs a valid login.

const SUPABASE_PUBLIC_URL = "https://dylkrvdnyefdeuxtchji.supabase.co";
// Public "anon" key (the same one already used in the web pages). It is safe to keep here.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5bGtydmRueWVmZGV1eHRjaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODgxNjEsImV4cCI6MjEwODE2NDE2MX0.cs0XsVKkoo61FwJMitjSGx3vdmYsfWpqovl7kTfgAp4";

const MAX_UPLOADS_PER_DAY = 5; // per user per day

// Returns { id, email } if the login token is valid, otherwise null
async function getUser(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_PUBLIC_URL + "/auth/v1/user", {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    return { id: user.id, email: String(user.email || "").toLowerCase() };
  } catch (e) {
    return null;
  }
}

// Counts how many times something happened today (needs the ai_usage table). Never breaks the upload.
async function bump(env, id) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      "INSERT INTO ai_usage (id, day, count) VALUES (?1, ?2, 1) " +
        "ON CONFLICT(id, day) DO UPDATE SET count = count + 1 RETURNING count"
    )
      .bind(id, day)
      .first();
    return row ? row.count : 0;
  } catch (e) {
    console.error("ai_usage table problem:", e);
    return 0;
  }
}

export async function onRequestPost({ request, env }) {
  let uploadedFileName = null;

  try {
    if (!env.DB || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      return Response.json(
        { error: "Server configuration is incomplete." },
        { status: 500 }
      );
    }

    // NEW: only logged-in users can upload
    const user = await getUser(request);
    if (!user) {
      return Response.json(
        { error: "Please login to upload a research paper." },
        { status: 401 }
      );
    }

    // NEW: limit uploads per user per day
    const uploads = await bump(env, "r:" + user.id);
    if (uploads > MAX_UPLOADS_PER_DAY) {
      return Response.json(
        { error: "Daily upload limit reached. Please try again tomorrow." },
        { status: 429 }
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

    // Keep a record of who uploaded (visible in the Cloudflare logs)
    console.log("Research uploaded by user:", user.id, "file:", fileName);

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
