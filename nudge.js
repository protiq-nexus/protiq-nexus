// nudge.js - a friendly "sign up" reminder for visitors who use the site a lot
// Add to a page with:  <script src="/nudge.js" defer></script>
(function () {
  var TIME_LIMIT = 8 * 60;          // seconds of active use before the first reminder (all pages together)
  var SNOOZE_HOURS = 24;            // how long "Not now" hides the reminder
  var K_TIME = "pq_time", K_SNOOZE = "pq_nudge_snooze";

  function loggedIn() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        if (/^sb-.*-auth-token$/.test(localStorage.key(i))) return true;
      }
    } catch (e) {}
    return false;
  }
  if (loggedIn()) return;
  if (/\/(login|profile|leaderboard)/.test(location.pathname)) return;

  function snoozed() {
    try {
      var t = parseInt(localStorage.getItem(K_SNOOZE) || "0", 10) || 0;
      return Date.now() - t < SNOOZE_HOURS * 3600 * 1000;
    } catch (e) { return false; }
  }

  var TEXT = {
    time: "You have been learning here for a while. Create a free account to save your progress on every device and join the leaderboard.",
    answers: "Great practice! Sign up free to keep your progress safe on every device and appear on the leaderboard.",
    ai: "Enjoying the AI? Sign up free to ask more questions every day and keep your progress."
  };

  function show(reason) {
    if (document.getElementById("pqNudge") || snoozed()) return;
    var box = document.createElement("div");
    box.id = "pqNudge";
    box.setAttribute("role", "dialog");
    box.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;width:min(560px,calc(100% - 24px));" +
      "background:#101a2b;border:1px solid #54ead5;border-radius:16px;padding:16px 18px;color:#f2f6ff;font-family:Arial,sans-serif;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:14px;line-height:1.5";
    var p = document.createElement("div");
    p.textContent = TEXT[reason] || TEXT.time;
    p.style.marginBottom = "12px";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;flex-wrap:wrap";
    var a = document.createElement("a");
    a.textContent = "Sign up free";
    a.href = "/login.html?next=" + encodeURIComponent(location.pathname);
    a.style.cssText = "background:linear-gradient(100deg,#347cf0,#24b8b0);color:#06101b;font-weight:800;padding:9px 16px;border-radius:9px;text-decoration:none";
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Not now";
    b.style.cssText = "background:transparent;border:1px solid #24334a;color:#f2f6ff;padding:9px 16px;border-radius:9px;cursor:pointer";
    b.onclick = function () {
      try { localStorage.setItem(K_SNOOZE, String(Date.now())); localStorage.setItem(K_TIME, "0"); } catch (e) {}
      box.remove();
    };
    row.appendChild(a); row.appendChild(b);
    box.appendChild(p); box.appendChild(row);
    document.body.appendChild(box);
  }
  window.pqNudge = show;

  // count active seconds (only while the tab is visible), shared by all pages
  var total = 0;
  try { total = parseInt(localStorage.getItem(K_TIME) || "0", 10) || 0; } catch (e) {}
  setInterval(function () {
    if (document.hidden) return;
    total += 1;
    try { localStorage.setItem(K_TIME, String(total)); } catch (e) {}
    if (total >= TIME_LIMIT) show("time");
  }, 1000);
})();
