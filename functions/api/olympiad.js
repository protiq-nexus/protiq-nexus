// functions/api/olympiad.js
// Olympiad questions with progress:
//  - a question that was answered is never shown again
//  - every part is harder than the one before (Beginner -> Intermediate -> Advanced)
//  - finishing a part unlocks the next one
//  - points are given only if the answer is correct AND no hint / description was used first
//  - answers are checked on the server and are never sent before the user answers

const SUPABASE_URL = "https://dylkrvdnyefdeuxtchji.supabase.co";
// Public "anon" key (the same one already used in the web pages). It is safe to keep here.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5bGtydmRueWVmZGV1eHRjaGppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1ODgxNjEsImV4cCI6MjEwODE2NDE2MX0.cs0XsVKkoo61FwJMitjSGx3vdmYsfWpqovl7kTfgAp4";

const TOPICS = [
  // Physics
  "Mechanics", "Electricity", "Optics", "Thermodynamics", "Modern Physics",
  // Chemistry
  "Physical Chemistry", "Organic Chemistry", "Inorganic Chemistry",
  // Mathematics
  "Algebra", "Calculus", "Geometry", "Number Theory",
  // Biology
  "Cell Biology", "Genetics", "Human Physiology", "Ecology & Evolution"
];
const SET_SIZE = 10;     // questions in one part
const GUEST_SAMPLE = 5;  // questions a guest can try (nothing is saved)

function json(data, status) {
  return Response.json(data, {
    status: status || 200,
    headers: { "Cache-Control": "private, no-store" }
  });
}

async function getUser(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id || !user.email) return null;
    return { id: user.id, email: String(user.email).toLowerCase() };
  } catch (e) {
    return null;
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

// ---------- hints (same texts as before) ----------
const HINTS = {
  Mechanics: [
    [["energy", "work", "power"], "Relate work, energy and power: W=Fs, KE=½mv², P=W/t."],
    [["momentum", "impulse", "collision"], "Use momentum p=mv and impulse = change in momentum."],
    [["circular", "centripetal"], "Centripetal acceleration is v²/r toward the centre."],
    [["shm", "harmonic", "pendulum"], "For small angles a simple pendulum is approximately SHM."],
    [["gravity", "satellite", "escape"], "Think Newton gravity: F=GMm/r² and orbital/escape speed formulas."]
  ],
  Electricity: [
    [["ohm", "resistance", "current"], "Start from Ohm’s law V=IR and series/parallel rules."],
    [["capacitor", "capacitance"], "C=Q/V and energy ½CV²; series/parallel for networks."],
    [["magnetic", "induced", "faraday"], "Use Faraday/Lenz: induced emf opposes change in flux."]
  ],
  Optics: [
    [["mirror", "lens", "focal"], "Use sign convention with mirror/lens formula carefully."],
    [["interference", "diffraction", "young"], "Path difference decides bright/dark; fringe width β=λD/d."],
    [["polar", "brewster"], "Polarization needs transverse waves; Brewster uses tan ip = μ."]
  ],
  Thermodynamics: [
    [["carnot", "efficiency"], "Carnot efficiency depends only on the two reservoir temperatures."],
    [["entropy", "second law"], "Entropy of the universe never decreases for real processes."],
    [["ideal gas", "isothermal", "adiabatic"], "For ideal gas U depends only on T; pick the right process relation."]
  ],
  "Modern Physics": [
    [["photoelectric", "photon", "work function"], "Use E=hf and Kmax=hf−φ; intensity changes number of electrons, not Kmax."],
    [["bohr", "hydrogen", "orbit"], "Bohr: L=nℏ and En=−13.6/n² eV for hydrogen."],
    [["nuclear", "radio", "decay", "half"], "Activity A=λN and remaining fraction halves each half-life."]
  ]
};
const TOPIC_DEFAULT_HINT = {
  Mechanics: "Identify the law (Newton, energy, rotation) before picking an option.",
  Electricity: "Write the basic circuit or field formula first, then eliminate options.",
  Optics: "Decide if the idea is ray optics or wave optics, then apply the matching rule.",
  Thermodynamics: "State the process type (iso-T, adiabatic, cycle) before calculating.",
  "Modern Physics": "Connect quanta, waves or nucleus ideas — avoid classical-only thinking.",
  "Physical Chemistry": "Write the balanced equation or the key formula (moles, pH, rate law) first, then substitute.",
  "Organic Chemistry": "Identify the functional group and the reaction type before choosing the product.",
  "Inorganic Chemistry": "Think about electron configuration, periodic trends and molecular shape (VSEPR).",
  "Algebra": "Try to simplify with identities or Vieta formulas before calculating.",
  "Calculus": "Recall the standard derivative, integral or limit rule that matches the form.",
  "Geometry": "Draw the figure and mark the known lengths and angles first.",
  "Number Theory": "Use divisibility rules, prime factorisation or modular arithmetic.",
  "Cell Biology": "Link each structure to its function inside the cell.",
  "Genetics": "Write the genotypes of the parents and use a Punnett square.",
  "Human Physiology": "Trace the pathway of the organ or hormone step by step.",
  "Ecology & Evolution": "Think about energy flow, populations and natural selection."
};

function makeHint(q) {
  const text = String(q.question || "").toLowerCase();
  if (text.includes("unit") || text.includes("si unit")) {
    return "Recall the standard SI unit and what physical quantity it measures.";
  }
  if (text.includes("dimension") || text.includes("dimensionless")) {
    return "Check whether the quantity has units or is a pure number ratio.";
  }
  const rules = HINTS[q.topic] || [];
  for (const [words, hint] of rules) {
    if (words.some((w) => text.includes(w))) return hint;
  }
  if (TOPIC_DEFAULT_HINT[q.topic]) return TOPIC_DEFAULT_HINT[q.topic];
  if (q.level === "Advanced") {
    return "Eliminate options that break units or limiting cases (0, ∞, special angles).";
  }
  return "Cross out options that clearly violate the basic definition, then compare the rest.";
}
// --------------------------------------------------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseOptions(raw) {
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(o) ? o.map(String) : [];
  } catch (e) {
    return [];
  }
}

async function getPart(env, email, topic) {
  const row = await env.DB.prepare(
    "SELECT part FROM user_progress WHERE user_email = ? AND topic = ?"
  ).bind(email, topic).first();
  return row && row.part ? row.part : 1;
}

async function setPart(env, email, topic, part) {
  await env.DB.prepare(
    "INSERT INTO user_progress (user_email, topic, part, correct_count, total_attempted, points, updated_at) " +
      "VALUES (?, ?, ?, 0, 0, 0, datetime('now')) " +
      "ON CONFLICT(user_email, topic) DO UPDATE SET part = excluded.part, updated_at = datetime('now')"
  ).bind(email, topic, part).run();
}

async function remainingCount(env, email, topic, level) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM olympiad_questions q WHERE q.topic = ? AND q.level = ? " +
      "AND q.id NOT IN (SELECT question_id FROM user_answers WHERE user_email = ? AND status = 'done')"
  ).bind(topic, level, email).first();
  return row ? row.c : 0;
}

async function doneInPart(env, email, topic, part) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM user_answers WHERE user_email = ? AND topic = ? AND part = ? AND status = 'done'"
  ).bind(email, topic, part).first();
  return row ? row.c : 0;
}

function publicQuestion(q) {
  return {
    id: q.id,
    topic: q.topic,
    level: q.level,
    question: q.question,
    options: shuffle(parseOptions(q.options))
  };
}

async function guestSampleIds(env, topic) {
  const res = await env.DB.prepare(
    "SELECT id FROM olympiad_questions WHERE topic = ? AND level = 'Beginner' ORDER BY id LIMIT ?"
  ).bind(topic, GUEST_SAMPLE).all();
  return (res.results || []).map((r) => r.id);
}

// ---------------- GET: the questions of the current part ----------------
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const topic = url.searchParams.get("topic") || "Mechanics";
    if (!TOPICS.includes(topic)) return json({ error: "Unknown topic." }, 400);

    const user = await getUser(request);

    // A topic with no questions yet: show "coming soon" and do not touch the user progress
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM olympiad_questions WHERE topic = ?"
    ).bind(topic).first();
    if (!totalRow || !totalRow.c) {
      return json({
        success: true, empty: true, guest: !user, topic, part: 1, level: "Beginner",
        set_size: SET_SIZE, done_in_part: 0, points_per_correct: pointsPerCorrect(1), questions: []
      });
    }

    // Guests: a small sample, nothing is saved
    if (!user) {
      const res = await env.DB.prepare(
        "SELECT id, topic, level, question, options FROM olympiad_questions " +
          "WHERE topic = ? AND level = 'Beginner' ORDER BY id LIMIT ?"
      ).bind(topic, GUEST_SAMPLE).all();
      return json({
        success: true,
        guest: true,
        topic,
        part: 1,
        level: "Beginner",
        set_size: GUEST_SAMPLE,
        done_in_part: 0,
        points_per_correct: pointsPerCorrect(1),
        questions: (res.results || []).map(publicQuestion)
      });
    }

    let part = await getPart(env, user.email, topic);
    let level = levelForPart(part);
    let done = await doneInPart(env, user.email, topic, part);
    let rows = [];

    // If a part has no questions left, move on to the next level
    for (let i = 0; i < 3; i++) {
      const res = await env.DB.prepare(
        "SELECT id, topic, level, question, options FROM olympiad_questions q " +
          "WHERE q.topic = ? AND q.level = ? " +
          "AND q.id NOT IN (SELECT question_id FROM user_answers WHERE user_email = ? AND status = 'done') " +
          "ORDER BY q.id LIMIT ?"
      ).bind(topic, level, user.email, Math.max(1, SET_SIZE - done)).all();
      rows = res.results || [];
      if (rows.length > 0 || level === "Advanced") break;
      part += 1;
      level = levelForPart(part);
      await setPart(env, user.email, topic, part);
      done = await doneInPart(env, user.email, topic, part);
    }

    const lb = await env.DB.prepare(
      "SELECT total_points FROM leaderboard WHERE user_email = ?"
    ).bind(user.email).first();

    return json({
      success: true,
      guest: false,
      topic,
      part,
      level,
      set_size: SET_SIZE,
      done_in_part: done,
      points_per_correct: pointsPerCorrect(part),
      my_points: lb ? lb.total_points || 0 : 0,
      finished: rows.length === 0,
      questions: rows.map(publicQuestion)
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Could not load questions" }, 500);
  }
}

// ---------------- POST: hint / description / answer ----------------
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const action = String(body.action || "");
    const questionId = parseInt(body.question_id, 10);
    if (!["hint", "describe", "answer"].includes(action) || !Number.isFinite(questionId)) {
      return json({ error: "Bad request." }, 400);
    }

    const q = await env.DB.prepare(
      "SELECT id, topic, level, question, options, correct_answer, explanation FROM olympiad_questions WHERE id = ?"
    ).bind(questionId).first();
    if (!q) return json({ error: "Question not found." }, 404);

    const user = await getUser(request);

    // ----- guests: only the sample questions, nothing is saved -----
    if (!user) {
      const ids = await guestSampleIds(env, q.topic);
      if (!ids.includes(q.id)) {
        return json({ error: "Please login to continue with more questions." }, 401);
      }
      if (action === "hint") return json({ hint: makeHint(q) });
      if (action === "describe") return json({ description: q.explanation || "No description available." });
      const correct = String(body.answer || "") === q.correct_answer;
      return json({
        success: true,
        guest: true,
        correct,
        correct_answer: q.correct_answer,
        explanation: q.explanation || "",
        earned: 0
      });
    }

    // ----- logged-in users -----
    const email = user.email;
    const part = await getPart(env, email, q.topic);
    if (q.level !== levelForPart(part)) {
      return json({ error: "This question is not in your current part." }, 403);
    }

    const row = await env.DB.prepare(
      "SELECT status, used_hint, used_description FROM user_answers WHERE user_email = ? AND question_id = ?"
    ).bind(email, q.id).first();
    const alreadyDone = row && row.status === "done";

    if (action === "hint" || action === "describe") {
      if (!alreadyDone) {
        const col = action === "hint" ? "used_hint" : "used_description";
        await env.DB.prepare(
          "INSERT INTO user_answers (user_email, question_id, topic, part, status, " + col + ") " +
            "VALUES (?, ?, ?, ?, 'open', 1) " +
            "ON CONFLICT(user_email, question_id) DO UPDATE SET " + col + " = 1 WHERE user_answers.status = 'open'"
        ).bind(email, q.id, q.topic, part).run();
      }
      return action === "hint"
        ? json({ hint: makeHint(q) })
        : json({ description: q.explanation || "No description available." });
    }

    // ----- answer -----
    if (alreadyDone) return json({ error: "You already answered this question." }, 409);

    const correct = String(body.answer || "") === q.correct_answer;
    const helpUsed = !!(row && (row.used_hint || row.used_description));
    const earned = correct && !helpUsed ? pointsPerCorrect(part) : 0;

    const saved = await env.DB.prepare(
      "INSERT INTO user_answers (user_email, question_id, topic, part, status, is_correct, points, answered_at) " +
        "VALUES (?, ?, ?, ?, 'done', ?, ?, datetime('now')) " +
        "ON CONFLICT(user_email, question_id) DO UPDATE SET status = 'done', part = excluded.part, " +
        "is_correct = excluded.is_correct, points = excluded.points, answered_at = datetime('now') " +
        "WHERE user_answers.status = 'open'"
    ).bind(email, q.id, q.topic, part, correct ? 1 : 0, earned).run();

    if (saved.meta && saved.meta.changes === 0) {
      return json({ error: "You already answered this question." }, 409);
    }

    await env.DB.prepare(
      "INSERT INTO user_progress (user_email, topic, part, correct_count, total_attempted, points, updated_at) " +
        "VALUES (?, ?, ?, ?, 1, ?, datetime('now')) " +
        "ON CONFLICT(user_email, topic) DO UPDATE SET " +
        "correct_count = correct_count + excluded.correct_count, " +
        "total_attempted = total_attempted + 1, " +
        "points = user_progress.points + excluded.points, updated_at = datetime('now')"
    ).bind(email, q.topic, part, correct ? 1 : 0, earned).run();

    if (earned > 0) {
      await env.DB.prepare(
        "INSERT INTO leaderboard (user_email, display_name, total_points, updated_at) " +
          "VALUES (?, NULL, ?, datetime('now')) " +
          "ON CONFLICT(user_email) DO UPDATE SET total_points = leaderboard.total_points + excluded.total_points, " +
          "updated_at = datetime('now')"
      ).bind(email, earned).run();
    }

    // Is the part finished?
    const done = await doneInPart(env, email, q.topic, part);
    const remaining = await remainingCount(env, email, q.topic, q.level);
    let setDone = false;
    let finished = false;
    let nextPart = part;
    if (remaining === 0 && q.level === "Advanced") {
      finished = true; // every question of the hardest level is done
    } else if (done >= SET_SIZE || remaining === 0) {
      setDone = true;
      nextPart = part + 1;
      await setPart(env, email, q.topic, nextPart);
    }

    return json({
      success: true,
      correct,
      correct_answer: q.correct_answer,
      explanation: q.explanation || "",
      earned,
      help_used: helpUsed,
      done_in_part: done,
      set_size: SET_SIZE,
      set_done: setDone,
      next_part: nextPart,
      finished
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
