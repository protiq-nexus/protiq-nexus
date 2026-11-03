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
const SET_SIZE = 10;     // questions in one set
const BEGINNER_LEVELS = 3;      // Level 1, 2, 3
const INTERMEDIATE_LEVELS = 3;  // Level 4, 5, 6
const PER_LEVEL = 10;           // every 10 questions of a stage make one level
// From Level 7 upward the Advanced levels never end: every extra 10 Advanced questions add one more level.
// Adaptive difficulty: after every set of SET_SIZE answers
//   8 or more correct  -> harder questions
//   5 to 7 correct     -> same level, new questions
//   fewer than 5       -> a little easier

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

// Guests get a random id from their browser, so their progress is saved on that device
const GUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUEST_DAILY_ANSWERS = 150; // answers per IP address per day for guests

async function getActor(request) {
  const user = await getUser(request);
  if (user) return { id: user.id, email: user.email, guest: false };
  const gid = (request.headers.get("X-Guest-Id") || "").trim().toLowerCase();
  if (GUEST_ID_RE.test(gid)) return { id: "g-" + gid, email: "guest:" + gid, guest: true };
  return null;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Daily counter (uses the ai_usage table). It never breaks the quiz if the table is missing.
async function bumpDaily(env, id) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      "INSERT INTO ai_usage (id, day, count) VALUES (?1, ?2, 1) " +
        "ON CONFLICT(id, day) DO UPDATE SET count = count + 1 RETURNING count"
    ).bind(id, day).first();
    return row ? row.count : 0;
  } catch (e) {
    console.error("ai_usage table problem:", e);
    return 0;
  }
}

// When a guest signs up, the guest progress is moved into the new account
async function claimGuest(request, env, body) {
  const user = await getUser(request);
  if (!user) return json({ error: "Please login first." }, 401);
  const gid = String(body.guest_id || "").trim().toLowerCase();
  if (!GUEST_ID_RE.test(gid)) return json({ error: "Bad guest id." }, 400);
  const guestEmail = "guest:" + gid;
  const email = user.email;

  const moved = await env.DB.prepare(
    "SELECT topic, COALESCE(SUM(is_correct), 0) AS c, COUNT(*) AS n, COALESCE(SUM(points), 0) AS p " +
      "FROM user_answers g WHERE g.user_email = ? AND g.status = 'done' " +
      "AND g.question_id NOT IN (SELECT question_id FROM user_answers WHERE user_email = ? AND status = 'done') " +
      "GROUP BY topic"
  ).bind(guestEmail, email).all();
  const gp = await env.DB.prepare("SELECT topic, part FROM user_progress WHERE user_email = ?").bind(guestEmail).all();
  const partOf = {};
  for (const r of gp.results || []) partOf[r.topic] = r.part;

  let totalPoints = 0, totalAnswers = 0;
  for (const r of moved.results || []) {
    totalPoints += r.p; totalAnswers += r.n;
    await env.DB.prepare(
      "INSERT INTO user_progress (user_email, topic, part, correct_count, total_attempted, points, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, datetime('now')) " +
        "ON CONFLICT(user_email, topic) DO UPDATE SET part = MAX(user_progress.part, excluded.part), " +
        "correct_count = user_progress.correct_count + excluded.correct_count, " +
        "total_attempted = user_progress.total_attempted + excluded.total_attempted, " +
        "points = user_progress.points + excluded.points, updated_at = datetime('now')"
    ).bind(email, r.topic, partOf[r.topic] || 1, r.c, r.n, r.p).run();
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO user_answers (user_email, question_id, topic, part, status, used_hint, used_description, is_correct, points, answered_at) " +
      "SELECT ?, question_id, topic, part, status, used_hint, used_description, is_correct, points, answered_at " +
      "FROM user_answers WHERE user_email = ?"
  ).bind(email, guestEmail).run();
  await env.DB.prepare("DELETE FROM user_answers WHERE user_email = ?").bind(guestEmail).run();
  await env.DB.prepare("DELETE FROM user_progress WHERE user_email = ?").bind(guestEmail).run();
  if (totalPoints > 0) {
    await env.DB.prepare(
      "INSERT INTO leaderboard (user_email, display_name, total_points, updated_at) VALUES (?, NULL, ?, datetime('now')) " +
        "ON CONFLICT(user_email) DO UPDATE SET total_points = leaderboard.total_points + excluded.total_points, updated_at = datetime('now')"
    ).bind(email, totalPoints).run();
  }
  return json({ success: true, moved: totalAnswers, points: totalPoints });
}

function levelForPart(L) {
  if (L <= BEGINNER_LEVELS) return "Beginner";
  if (L <= BEGINNER_LEVELS + INTERMEDIATE_LEVELS) return "Intermediate";
  return "Advanced";
}

function pointsPerCorrect(L) {
  return 10 + 5 * (L - 1); // Level 1 = 10 points, Level 7 = 40 points, and so on
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

async function doneInTopic(env, email, topic) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM user_answers WHERE user_email = ? AND topic = ? AND status = 'done'"
  ).bind(email, topic).first();
  return row ? row.c : 0;
}

async function remainingTopicCount(env, email, topic) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM olympiad_questions q WHERE q.topic = ? " +
      "AND q.id NOT IN (SELECT question_id FROM user_answers WHERE user_email = ? AND status = 'done')"
  ).bind(topic, email).first();
  return row ? row.c : 0;
}

// Every question gets a difficulty number (its level): Beginner 1-3, Intermediate 4-6, Advanced 7, 8, 9, ...
const DIFF_SQL =
  "WITH r AS (SELECT id, topic, level, question, options, correct_answer, explanation, " +
  "ROW_NUMBER() OVER (PARTITION BY level ORDER BY id) AS rn FROM olympiad_questions WHERE topic = ?1), " +
  "d AS (SELECT *, CASE level " +
  "WHEN 'Beginner' THEN MIN(1 + (rn - 1) / " + PER_LEVEL + ", " + BEGINNER_LEVELS + ") " +
  "WHEN 'Intermediate' THEN " + BEGINNER_LEVELS + " + MIN(1 + (rn - 1) / " + PER_LEVEL + ", " + INTERMEDIATE_LEVELS + ") " +
  "ELSE " + (BEGINNER_LEVELS + INTERMEDIATE_LEVELS) + " + 1 + (rn - 1) / " + PER_LEVEL + " END AS diff FROM r) ";

// The unanswered questions closest to the user level (new questions only, never a repeat)
async function nextRows(env, email, topic, L, limit) {
  const res = await env.DB.prepare(
    DIFF_SQL +
      "SELECT id, topic, level, question, options, diff FROM d " +
      "WHERE id NOT IN (SELECT question_id FROM user_answers WHERE user_email = ?2 AND status = 'done') " +
      "ORDER BY ABS(diff - ?3), diff, id LIMIT ?4"
  ).bind(topic, email, L, Math.max(1, limit)).all();
  return res.results || [];
}

async function maxDifficulty(env, topic) {
  const row = await env.DB.prepare(DIFF_SQL + "SELECT MAX(diff) AS m FROM d").bind(topic).first();
  return row && row.m ? row.m : 1;
}

function publicQuestion(q) {
  return {
    id: q.id,
    topic: q.topic,
    level: q.level,
    difficulty: q.diff || null,
    question: q.question,
    options: shuffle(parseOptions(q.options))
  };
}

// ---------------- GET: the questions of the current part ----------------
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const topic = url.searchParams.get("topic") || "Mechanics";
    if (!TOPICS.includes(topic)) return json({ error: "Unknown topic." }, 400);

    const user = await getActor(request);
    if (!user) return json({ error: "Please reload the page." }, 400);

    // A topic with no questions yet: show "coming soon" and do not touch the user progress
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM olympiad_questions WHERE topic = ?"
    ).bind(topic).first();
    if (!totalRow || !totalRow.c) {
      return json({
        success: true, empty: true, guest: user.guest, topic, part: 1, level: "Beginner",
        set_size: SET_SIZE, done_in_part: 0, points_per_correct: pointsPerCorrect(1), questions: []
      });
    }

    const part = await getPart(env, user.email, topic); // the user level number
    const level = levelForPart(part);
    const totalDone = await doneInTopic(env, user.email, topic);
    const doneInSet = totalDone % SET_SIZE;
    const rows = await nextRows(env, user.email, topic, part, SET_SIZE - doneInSet);

    const pts = await env.DB.prepare(
      "SELECT COALESCE(SUM(points), 0) AS p FROM user_progress WHERE user_email = ?"
    ).bind(user.email).first();
    const st = await env.DB.prepare(
      "SELECT correct_count, total_attempted FROM user_progress WHERE user_email = ? AND topic = ?"
    ).bind(user.email, topic).first();
    const attempted = st ? st.total_attempted || 0 : 0;
    const accuracy = attempted > 0 ? Math.round(((st.correct_count || 0) / attempted) * 100) : null;

    return json({
      success: true,
      guest: user.guest,
      topic,
      part,
      level,
      set_size: SET_SIZE,
      done_in_part: doneInSet,
      points_per_correct: pointsPerCorrect(part),
      my_points: pts ? pts.p || 0 : 0,
      answered: attempted,
      accuracy,
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
    if (String(body.action || "") === "claim") return await claimGuest(request, env, body);
    const action = String(body.action || "");
    const questionId = parseInt(body.question_id, 10);
    if (!["hint", "describe", "answer"].includes(action) || !Number.isFinite(questionId)) {
      return json({ error: "Bad request." }, 400);
    }

    const q = await env.DB.prepare(
      "SELECT id, topic, level, question, options, correct_answer, explanation FROM olympiad_questions WHERE id = ?"
    ).bind(questionId).first();
    if (!q) return json({ error: "Question not found." }, 404);

    const user = await getActor(request);
    if (!user) return json({ error: "Please reload the page." }, 400);

    const email = user.email;
    const part = await getPart(env, email, q.topic);

    const row = await env.DB.prepare(
      "SELECT status, used_hint, used_description FROM user_answers WHERE user_email = ? AND question_id = ?"
    ).bind(email, q.id).first();
    const alreadyDone = row && row.status === "done";

    // Only the questions currently offered to this user can be hinted or answered
    if (!alreadyDone) {
      const doneNow = await doneInTopic(env, email, q.topic);
      const cand = await nextRows(env, email, q.topic, part, SET_SIZE - (doneNow % SET_SIZE));
      if (!cand.some((c) => c.id === q.id)) {
        return json({ error: "This question is not in your current set." }, 403);
      }
    }

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

    // Guests can practise a lot, but with a daily limit per IP address (sign up is free and has no such limit)
    if (user.guest) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const used = await bumpDaily(env, "go:" + (await sha256Hex(ip)));
      if (used > GUEST_DAILY_ANSWERS) {
        return json({ error: "You have reached today's limit for guest practice. Please sign up (it is free) to continue.", signup: true }, 429);
      }
    }

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

    if (earned > 0 && !user.guest) { // only real accounts appear on the leaderboard
      await env.DB.prepare(
        "INSERT INTO leaderboard (user_email, display_name, total_points, updated_at) " +
          "VALUES (?, NULL, ?, datetime('now')) " +
          "ON CONFLICT(user_email) DO UPDATE SET total_points = leaderboard.total_points + excluded.total_points, " +
          "updated_at = datetime('now')"
      ).bind(email, earned).run();
    }

    // Adaptive difficulty: after every set of answers look at the accuracy
    const totalDone = await doneInTopic(env, email, q.topic);
    const doneInSet = totalDone % SET_SIZE === 0 ? SET_SIZE : totalDone % SET_SIZE;
    const remainingTopic = await remainingTopicCount(env, email, q.topic);
    let setDone = false;
    let finished = false;
    let nextPart = part;
    let levelChange = "same";
    let setCorrect = null;
    if (remainingTopic === 0) {
      finished = true; // every question of this topic is done
    } else if (totalDone % SET_SIZE === 0) {
      setDone = true;
      const last = await env.DB.prepare(
        "SELECT COALESCE(SUM(is_correct), 0) AS c FROM (" +
          "SELECT is_correct FROM user_answers WHERE user_email = ? AND topic = ? AND status = 'done' " +
          "ORDER BY answered_at DESC, rowid DESC LIMIT ?)"
      ).bind(email, q.topic, SET_SIZE).first();
      setCorrect = last ? last.c : 0;
      if (setCorrect >= 8) {
        const top = await maxDifficulty(env, q.topic);
        nextPart = Math.min(part + 1, Math.max(top, part));
        levelChange = nextPart > part ? "up" : "same";
      } else if (setCorrect < 5) {
        nextPart = Math.max(1, part - 1);
        levelChange = nextPart < part ? "down" : "same";
      }
      if (nextPart !== part) await setPart(env, email, q.topic, nextPart);
    }
    const reload = false;

    return json({
      success: true,
      correct,
      correct_answer: q.correct_answer,
      explanation: q.explanation || "",
      earned,
      help_used: helpUsed,
      done_in_part: doneInSet,
      set_size: SET_SIZE,
      set_done: setDone,
      set_correct: setCorrect,
      level_change: levelChange,
      next_level: levelForPart(nextPart),
      next_part: nextPart,
      reload,
      finished
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
