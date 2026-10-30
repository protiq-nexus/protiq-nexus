// functions/api/quiz.js
// GET  = anyone can load practice questions (guests included)
// POST = saving points needs a valid login; identity comes from the login token, not from the page

const SUPABASE_URL = "https://dylkrvdnyefdeuxtchji.supabase.co";
// Public "anon" key (the same one already used in the web pages). It is safe to keep here.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5bGtydmRueWVmZGV1eHRjaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODgxNjEsImV4cCI6MjEwODE2NDE2MX0.cs0XsVKkoo61FwJMitjSGx3vdmYsfWpqovl7kTfgAp4";

const TOPICS = ["Mechanics", "Electricity", "Optics", "Thermodynamics", "Modern Physics"];
const MAX_SCORED_SUBMITS_PER_DAY = 30; // per user per day

// Returns { id, email } if the login token is valid, otherwise null
async function getUser(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id || !user.email) return null;
    return { id: user.id, email: String(user.email).toLowerCase() };
  } catch (e) {
    return null;
  }
}

// Counts how many times something happened today (needs the ai_usage table). Never breaks the quiz.
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

function makeHint(q) {
  const topic = String(q.topic || "");
  const level = String(q.level || "");
  const question = String(q.question || "").toLowerCase();

  if (question.includes("unit") || question.includes("si unit")) {
    return "Recall the standard SI unit and what physical quantity it measures.";
  }
  if (question.includes("dimension") || question.includes("dimensionless")) {
    return "Check whether the quantity has units or is a pure number ratio.";
  }

  if (topic === "Mechanics") {
    if (question.includes("energy") || question.includes("work") || question.includes("power")) {
      return "Relate work, energy and power: W=Fs, KE=½mv², P=W/t.";
    }
    if (question.includes("momentum") || question.includes("impulse") || question.includes("collision")) {
      return "Use momentum p=mv and impulse = change in momentum.";
    }
    if (question.includes("circular") || question.includes("centripetal")) {
      return "Centripetal acceleration is v²/r toward the centre.";
    }
    if (question.includes("shm") || question.includes("harmonic") || question.includes("pendulum")) {
      return "For small angles a simple pendulum is approximately SHM.";
    }
    if (question.includes("gravity") || question.includes("satellite") || question.includes("escape")) {
      return "Think Newton gravity: F=GMm/r² and orbital/escape speed formulas.";
    }
    return "Identify the law (Newton, energy, rotation) before picking an option.";
  }

  if (topic === "Electricity") {
    if (question.includes("ohm") || question.includes("resistance") || question.includes("current")) {
      return "Start from Ohm’s law V=IR and series/parallel rules.";
    }
    if (question.includes("capacitor") || question.includes("capacitance")) {
      return "C=Q/V and energy ½CV²; series/parallel for networks.";
    }
    if (question.includes("magnetic") || question.includes("induced") || question.includes("faraday")) {
      return "Use Faraday/Lenz: induced emf opposes change in flux.";
    }
    return "Write the basic circuit or field formula first, then eliminate options.";
  }

  if (topic === "Optics") {
    if (question.includes("mirror") || question.includes("lens") || question.includes("focal")) {
      return "Use sign convention with mirror/lens formula carefully.";
    }
    if (question.includes("interference") || question.includes("diffraction") || question.includes("young")) {
      return "Path difference decides bright/dark; fringe width β=λD/d.";
    }
    if (question.includes("polar") || question.includes("brewster")) {
      return "Polarization needs transverse waves; Brewster uses tan ip = μ.";
    }
    return "Decide if the idea is ray optics or wave optics, then apply the matching rule.";
  }

  if (topic === "Thermodynamics") {
    if (question.includes("carnot") || question.includes("efficiency")) {
      return "Carnot efficiency depends only on the two reservoir temperatures.";
    }
    if (question.includes("entropy") || question.includes("second law")) {
      return "Entropy of the universe never decreases for real processes.";
    }
    if (question.includes("ideal gas") || question.includes("isothermal") || question.includes("adiabatic")) {
      return "For ideal gas U depends only on T; pick the right process relation.";
    }
    return "State the process type (iso-T, adiabatic, cycle) before calculating.";
  }

  if (topic === "Modern Physics") {
    if (question.includes("photoelectric") || question.includes("photon") || question.includes("work function")) {
      return "Use E=hf and Kmax=hf−φ; intensity changes number of electrons, not Kmax.";
    }
    if (question.includes("bohr") || question.includes("hydrogen") || question.includes("orbit")) {
      return "Bohr: L=nℏ and En=−13.6/n² eV for hydrogen.";
    }
    if (
      question.includes("nuclear") ||
      question.includes("radio") ||
      question.includes("decay") ||
      question.includes("half")
    ) {
      return "Activity A=λN and remaining fraction halves each half-life.";
    }
    return "Connect quanta, waves or nucleus ideas — avoid classical-only thinking.";
  }

  if (level === "Advanced") {
    return "Eliminate options that break units or limiting cases (0, ∞, special angles).";
  }
  return "Cross out options that clearly violate the basic definition, then compare the rest.";
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const topic = url.searchParams.get("topic") || "Mechanics";
    const part = Math.max(1, parseInt(url.searchParams.get("part") || "1", 10) || 1);
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
      return {
        id: q.id,
        topic: q.topic,
        level: q.level,
        question: q.question,
        options,
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        hint: makeHint(q),
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
    // NEW: only logged-in users can save points. The email comes from the token, never from the page.
    const user = await getUser(request);
    if (!user) {
      return Response.json({ error: "Please login to save your score." }, { status: 401 });
    }
    const email = user.email;

    const body = await request.json();
    const topic = String(body.topic || "").trim();

    // NEW: sanitise numbers sent by the page
    let part = parseInt(body.part, 10);
    if (!Number.isFinite(part)) part = 1;
    part = Math.min(1000, Math.max(1, part));

    let total = parseInt(body.total, 10);
    if (!Number.isFinite(total)) total = 10;
    total = Math.min(10, Math.max(1, total));

    let correct = parseInt(body.correct, 10);
    if (!Number.isFinite(correct)) correct = 0;
    correct = Math.min(total, Math.max(0, correct));

    if (!TOPICS.includes(topic)) {
      return Response.json({ error: "Unknown topic." }, { status: 400 });
    }

    // NEW: limit how many scores one user can submit per day
    const submits = await bump(env, "q:" + user.id);
    if (submits > MAX_SCORED_SUBMITS_PER_DAY) {
      return Response.json(
        { error: "Daily limit for saved attempts reached. Please try again tomorrow." },
        { status: 429 }
      );
    }

    const existing = await env.DB.prepare(
      `SELECT points, part FROM user_progress WHERE user_email = ? AND topic = ?`
    )
      .bind(email, topic)
      .first();

    // NEW: a part can be scored only after it has been unlocked
    const unlockedPart = existing?.part || 1;
    if (part > unlockedPart) {
      return Response.json({ error: "This part is not unlocked yet." }, { status: 403 });
    }

    const earned = pointsForPart(part, correct);
    const unlockedNext = correct >= 7;
    const nextPart = unlockedNext ? part + 1 : part;
    const savedPart = Math.max(unlockedPart, nextPart);

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

    await env.DB.prepare(
      `INSERT INTO leaderboard (user_email, display_name, total_points, updated_at)
       VALUES (?, NULL, ?, datetime('now'))
       ON CONFLICT(user_email) DO UPDATE SET
         total_points = leaderboard.total_points + excluded.total_points,
         updated_at = datetime('now')`
    )
      .bind(email, earned)
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
